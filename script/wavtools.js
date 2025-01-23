(() => {
  // lib/wav_packer.js
  var WavPacker = class {
    /**
     * Converts Float32Array of amplitude data to ArrayBuffer in Int16Array format
     * @param {Float32Array} float32Array
     * @returns {ArrayBuffer}
     */
    static floatTo16BitPCM(float32Array) {
      const buffer = new ArrayBuffer(float32Array.length * 2);
      const view = new DataView(buffer);
      let offset = 0;
      for (let i = 0; i < float32Array.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, float32Array[i]));
        view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
      }
      return buffer;
    }
    /**
     * Concatenates two ArrayBuffers
     * @param {ArrayBuffer} leftBuffer
     * @param {ArrayBuffer} rightBuffer
     * @returns {ArrayBuffer}
     */
    static mergeBuffers(leftBuffer, rightBuffer) {
      const tmpArray = new Uint8Array(
        leftBuffer.byteLength + rightBuffer.byteLength
      );
      tmpArray.set(new Uint8Array(leftBuffer), 0);
      tmpArray.set(new Uint8Array(rightBuffer), leftBuffer.byteLength);
      return tmpArray.buffer;
    }
    /**
     * Packs data into an Int16 format
     * @private
     * @param {number} size 0 = 1x Int16, 1 = 2x Int16
     * @param {number} arg value to pack
     * @returns
     */
    _packData(size, arg) {
      return [
        new Uint8Array([arg, arg >> 8]),
        new Uint8Array([arg, arg >> 8, arg >> 16, arg >> 24])
      ][size];
    }
    /**
     * Packs audio into "audio/wav" Blob
     * @param {number} sampleRate
     * @param {{bitsPerSample: number, channels: Array<Float32Array>, data: Int16Array}} audio
     * @returns {WavPackerAudioType}
     */
    pack(sampleRate, audio) {
      if (!audio?.bitsPerSample) {
        throw new Error(`Missing "bitsPerSample"`);
      } else if (!audio?.channels) {
        throw new Error(`Missing "channels"`);
      } else if (!audio?.data) {
        throw new Error(`Missing "data"`);
      }
      const { bitsPerSample, channels, data } = audio;
      const output = [
        // Header
        "RIFF",
        this._packData(
          1,
          4 + (8 + 24) + (8 + 8)
          /* chunk 2 length */
        ),
        // Length
        "WAVE",
        // chunk 1
        "fmt ",
        // Sub-chunk identifier
        this._packData(1, 16),
        // Chunk length
        this._packData(0, 1),
        // Audio format (1 is linear quantization)
        this._packData(0, channels.length),
        this._packData(1, sampleRate),
        this._packData(1, sampleRate * channels.length * bitsPerSample / 8),
        // Byte rate
        this._packData(0, channels.length * bitsPerSample / 8),
        this._packData(0, bitsPerSample),
        // chunk 2
        "data",
        // Sub-chunk identifier
        this._packData(
          1,
          channels[0].length * channels.length * bitsPerSample / 8
        ),
        // Chunk length
        data
      ];
      const blob = new Blob(output, { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      return {
        blob,
        url,
        channelCount: channels.length,
        sampleRate,
        duration: data.byteLength / (channels.length * sampleRate * 2)
      };
    }
  };
  globalThis.WavPacker = WavPacker;

  // lib/analysis/constants.js
  var octave8Frequencies = [
    4186.01,
    4434.92,
    4698.63,
    4978.03,
    5274.04,
    5587.65,
    5919.91,
    6271.93,
    6644.88,
    7040,
    7458.62,
    7902.13
  ];
  var octave8FrequencyLabels = [
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B"
  ];
  var noteFrequencies = [];
  var noteFrequencyLabels = [];
  for (let i = 1; i <= 8; i++) {
    for (let f = 0; f < octave8Frequencies.length; f++) {
      const freq = octave8Frequencies[f];
      noteFrequencies.push(freq / Math.pow(2, 8 - i));
      noteFrequencyLabels.push(octave8FrequencyLabels[f] + i);
    }
  }
  var voiceFrequencyRange = [32, 2e3];
  var voiceFrequencies = noteFrequencies.filter((_, i) => {
    return noteFrequencies[i] > voiceFrequencyRange[0] && noteFrequencies[i] < voiceFrequencyRange[1];
  });
  var voiceFrequencyLabels = noteFrequencyLabels.filter((_, i) => {
    return noteFrequencies[i] > voiceFrequencyRange[0] && noteFrequencies[i] < voiceFrequencyRange[1];
  });

  // lib/analysis/audio_analysis.js
  var AudioAnalysis = class _AudioAnalysis {
    /**
     * Retrieves frequency domain data from an AnalyserNode adjusted to a decibel range
     * returns human-readable formatting and labels
     * @param {AnalyserNode} analyser
     * @param {number} sampleRate
     * @param {Float32Array} [fftResult]
     * @param {"frequency"|"music"|"voice"} [analysisType]
     * @param {number} [minDecibels] default -100
     * @param {number} [maxDecibels] default -30
     * @returns {AudioAnalysisOutputType}
     */
    static getFrequencies(analyser, sampleRate, fftResult, analysisType = "frequency", minDecibels = -100, maxDecibels = -30) {
      if (!fftResult) {
        fftResult = new Float32Array(analyser.frequencyBinCount);
        analyser.getFloatFrequencyData(fftResult);
      }
      const nyquistFrequency = sampleRate / 2;
      const frequencyStep = 1 / fftResult.length * nyquistFrequency;
      let outputValues;
      let frequencies;
      let labels;
      if (analysisType === "music" || analysisType === "voice") {
        const useFrequencies = analysisType === "voice" ? voiceFrequencies : noteFrequencies;
        const aggregateOutput = Array(useFrequencies.length).fill(minDecibels);
        for (let i = 0; i < fftResult.length; i++) {
          const frequency = i * frequencyStep;
          const amplitude = fftResult[i];
          for (let n = useFrequencies.length - 1; n >= 0; n--) {
            if (frequency > useFrequencies[n]) {
              aggregateOutput[n] = Math.max(aggregateOutput[n], amplitude);
              break;
            }
          }
        }
        outputValues = aggregateOutput;
        frequencies = analysisType === "voice" ? voiceFrequencies : noteFrequencies;
        labels = analysisType === "voice" ? voiceFrequencyLabels : noteFrequencyLabels;
      } else {
        outputValues = Array.from(fftResult);
        frequencies = outputValues.map((_, i) => frequencyStep * i);
        labels = frequencies.map((f) => `${f.toFixed(2)} Hz`);
      }
      const normalizedOutput = outputValues.map((v) => {
        return Math.max(
          0,
          Math.min((v - minDecibels) / (maxDecibels - minDecibels), 1)
        );
      });
      const values = new Float32Array(normalizedOutput);
      return {
        values,
        frequencies,
        labels
      };
    }
    /**
     * Creates a new AudioAnalysis instance for an HTMLAudioElement
     * @param {HTMLAudioElement} audioElement
     * @param {AudioBuffer|null} [audioBuffer] If provided, will cache all frequency domain data from the buffer
     * @returns {AudioAnalysis}
     */
    constructor(audioElement, audioBuffer = null) {
      this.fftResults = [];
      if (audioBuffer) {
        const { length, sampleRate } = audioBuffer;
        const offlineAudioContext = new OfflineAudioContext({
          length,
          sampleRate
        });
        const source = offlineAudioContext.createBufferSource();
        source.buffer = audioBuffer;
        const analyser = offlineAudioContext.createAnalyser();
        analyser.fftSize = 8192;
        analyser.smoothingTimeConstant = 0.1;
        source.connect(analyser);
        const renderQuantumInSeconds = 1 / 60;
        const durationInSeconds = length / sampleRate;
        const analyze = (index) => {
          const suspendTime = renderQuantumInSeconds * index;
          if (suspendTime < durationInSeconds) {
            offlineAudioContext.suspend(suspendTime).then(() => {
              const fftResult = new Float32Array(analyser.frequencyBinCount);
              analyser.getFloatFrequencyData(fftResult);
              this.fftResults.push(fftResult);
              analyze(index + 1);
            });
          }
          if (index === 1) {
            offlineAudioContext.startRendering();
          } else {
            offlineAudioContext.resume();
          }
        };
        source.start(0);
        analyze(1);
        this.audio = audioElement;
        this.context = offlineAudioContext;
        this.analyser = analyser;
        this.sampleRate = sampleRate;
        this.audioBuffer = audioBuffer;
      } else {
        const audioContext = new AudioContext();
        const track = audioContext.createMediaElementSource(audioElement);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 8192;
        analyser.smoothingTimeConstant = 0.1;
        track.connect(analyser);
        analyser.connect(audioContext.destination);
        this.audio = audioElement;
        this.context = audioContext;
        this.analyser = analyser;
        this.sampleRate = this.context.sampleRate;
        this.audioBuffer = null;
      }
    }
    /**
     * Gets the current frequency domain data from the playing audio track
     * @param {"frequency"|"music"|"voice"} [analysisType]
     * @param {number} [minDecibels] default -100
     * @param {number} [maxDecibels] default -30
     * @returns {AudioAnalysisOutputType}
     */
    getFrequencies(analysisType = "frequency", minDecibels = -100, maxDecibels = -30) {
      let fftResult = null;
      if (this.audioBuffer && this.fftResults.length) {
        const pct = this.audio.currentTime / this.audio.duration;
        const index = Math.min(
          pct * this.fftResults.length | 0,
          this.fftResults.length - 1
        );
        fftResult = this.fftResults[index];
      }
      return _AudioAnalysis.getFrequencies(
        this.analyser,
        this.sampleRate,
        fftResult,
        analysisType,
        minDecibels,
        maxDecibels
      );
    }
    /**
     * Resume the internal AudioContext if it was suspended due to the lack of
     * user interaction when the AudioAnalysis was instantiated.
     * @returns {Promise<true>}
     */
    async resumeIfSuspended() {
      if (this.context.state === "suspended") {
        await this.context.resume();
      }
      return true;
    }
  };
  globalThis.AudioAnalysis = AudioAnalysis;

  // lib/worklets/stream_processor.js
  var StreamProcessorWorklet = `
// StreamProcessor

class StreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.hasStarted = false;
    this.hasInterrupted = false;
    this.outputBuffers = [];
    this.bufferLength = 128;
    this.writeTrackId = null;
    
    // configuration
    this.playbackRateMin = 1.0;
    this.playbackRateMax = 1.0;
    this.playbackRateAffordance = 0.2;
    this.playbackSmoothing = 0.9;
    this.playbackSkipDigitalSilence = true;
    this.playbackMinBuffers = 16; // 16 * 128 samples @ 24kHz ~ 85ms (2 server frames)
    
    // state
    this.playbackRate = 1.0;
    this.playbackOutputOffset = 0;
    this.isInPlayback = false;
    
    this.trackSampleOffsets = {};
    this.port.onmessage = (event) => {
      if (event.data) {
        const payload = event.data;
        if (payload.event === 'write') {
          const int16Array = payload.buffer;
          const float32Array = new Float32Array(int16Array.length);
          for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 0x8000; // Convert Int16 to Float32
          }
          this.writeTrackId = payload.trackId;
          this.writeData(float32Array, payload.trackId);
        } else if (
          payload.event === 'offset' ||
          payload.event === 'interrupt'
        ) {
          const requestId = payload.requestId;
          const trackId = payload.trackId || this.writeTrackId;
          const offset = this.trackSampleOffsets[trackId] || 0;
          this.port.postMessage({
            event: 'offset',
            requestId,
            trackId,
            offset,
          });
          if (payload.event === 'interrupt') {
            this.hasInterrupted = true;
          }
        } else if (payload.event === 'configure') {
          const config = {
            playbackMinBuffers: this.playbackMinBuffers,
            playbackRateMin: this.playbackRateMin,
            playbackRateMax: this.playbackRateMax,
            playbackRateAffordance: this.playbackRateAffordance,
            playbackSmoothing: this.playbackSmoothing,
            playbackSkipDigitalSilence: this.playbackSkipDigitalSilence,
            ...payload.config,
          };

          // this.port.postMessage({ event: 'log', data: '[worker] Configuring ' + JSON.stringify(config) });

          this.playbackMinBuffers = config.playbackMinBuffers;
          this.playbackRateMin = config.playbackRateMin;
          this.playbackRateMax = config.playbackRateMax;
          this.playbackRateAffordance = config.playbackRateAffordance;
          this.playbackSmoothing = config.playbackSmoothing;
          this.playbackSkipDigitalSilence = config.playbackSkipDigitalSilence;
        } else {
          throw new Error('Unhandled event: ' + payload.event);
        }
      }
    };
  }

  writeData(float32Array, trackId = null) {
    let isSilence = true;
    for (let i = 0; i < float32Array.length; ++i) {
      if (float32Array[i] !== 0) {
        isSilence = false;
        break;
      }
    }

    this.outputBuffers.push({ trackId, buffer: float32Array, isSilence: isSilence });

    // this.port.postMessage({ event: 'log', data: '[worker] Consumed ' + float32Array.length + ' samples (silence: ' + isSilence + ')' });
    return true;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const outputChannelData = output[0];
    const outputBuffers = this.outputBuffers;

    if (this.hasInterrupted) {
      this.port.postMessage({ event: 'stop' });
      return false;
    } else {
      let totalSamples = 0;
      let samplesRead = 0;
      let samplesMoved = 0;
      let samplesWritten = 0

      if (outputBuffers.length > 0) {
        const outputChanneDataSampledNeeded = outputChannelData.length;
        const serverSamplesTarget = this.playbackMinBuffers * this.bufferLength;
        
        // determine if we should consume the output buffer(s)
        let consumableSamples = -this.playbackOutputOffset;
        let shouldConsumeBuffer = false;
        
        if (this.playbackSkipDigitalSilence) {
          // count total buffered after initial non-silence buffer
          let foundNonSilence = false;
          for (let i = 0; i < outputBuffers.length; ++i) {
            const { buffer, isSilence } = outputBuffers[i];

            totalSamples += buffer.length;

            // consider a sample as consumable if we are in or entering playback or if it is non-silence
            if (this.isInPlayback || !isSilence || foundNonSilence) {
              consumableSamples += buffer.length;
              foundNonSilence = true;
            }
          }
          
          // consume samples only if we are already in playback or we've buffered enough
          shouldConsumeBuffer = this.isInPlayback || consumableSamples >= serverSamplesTarget;
        } else {
          for (let i = 0; i < outputBuffers.length; ++i) {
            const { buffer } = outputBuffers[i];
            
            totalSamples += buffer.length;
            consumableSamples += buffer.length;
          }
          
          // start continuous consumption once initial buffering is met
          shouldConsumeBuffer = this.hasStarted || consumableSamples >= serverSamplesTarget;
        }

        if (shouldConsumeBuffer && consumableSamples > 0) {
          // apply playback rate to determine how many samples to consume
          const playbackRateTarget = this.determinePlaybackRate(consumableSamples, serverSamplesTarget);
          this.playbackRate = this.playbackRate * this.playbackSmoothing + playbackRateTarget * (1 - this.playbackSmoothing);
  
          const outputBufferSamplesNeeded = Math.floor(outputChanneDataSampledNeeded * this.playbackRate);
          const outputBuffer = new Float32Array(outputBufferSamplesNeeded);

          // this.port.postMessage({ event: 'log', data: '[worker] Consuming ' + outputBufferSamplesNeeded + ' of ' + consumableSamples + ' samples (total: ' + totalSamples + ') @ ' + this.playbackRate });

          // read the necessary (or as many as available) samples from the outputBuffers
          let outputBufferIndex = 0;
          let outputBufferOffset = this.playbackOutputOffset;
          let outputTrackId = null;
          while (outputBufferIndex < outputBuffers.length) {
            const { trackId, buffer, isSilence } = outputBuffers[outputBufferIndex];

            outputTrackId = trackId;

            // skip full buffers of silence (if enabled)
            if (this.playbackSkipDigitalSilence) {
              if (isSilence && outputBufferOffset === 0) {
                samplesMoved += buffer.length;
                // advance buffer
                outputBufferIndex++;
                continue;
              }
            }

            // read samples from the buffer
            for (let j = outputBufferOffset; j < buffer.length && samplesRead < outputBufferSamplesNeeded; ++j) {
              outputBuffer[samplesRead++] = buffer[j];
              samplesMoved++;
              
              // advance output buffer
              if (j === buffer.length - 1) {
                outputBufferOffset = 0;
                outputBufferIndex++;
              } else {
                outputBufferOffset++;
              }
            }

            // done if read enough samples
            if (samplesRead === outputBufferSamplesNeeded) {
              break;
            }
          }

          // done if no samples
          if (samplesRead > 0) {
            // apply playback rate to output buffer
            const resampledBuffer = this.resampleAudioData(outputBuffer, outputChanneDataSampledNeeded);
            
            // write the resampled buffer to the output channel
            for (let i = 0; i < resampledBuffer.length && samplesWritten < outputChanneDataSampledNeeded; ++i) {
              outputChannelData[samplesWritten++] = resampledBuffer[i];
            }

            // update output buffers
            this.outputBuffers = this.outputBuffers.slice(outputBufferIndex);
            this.playbackOutputOffset = outputBufferOffset;
          
            if (outputTrackId) {
              this.trackSampleOffsets[outputTrackId] =
                this.trackSampleOffsets[outputTrackId] || 0;
              this.trackSampleOffsets[outputTrackId] += resampledBuffer.length;
            }
          }
        }
      }

      if (samplesRead > 0) {
        this.hasStarted = true;
      }

      if (samplesWritten > 0) {
        this.isInPlayback = true;
      } else {
        this.isInPlayback = false;
      }

      // post audio playback timestamp
      this.port.postMessage({
        event: 'audio',
        data: samplesMoved,
        underrun: Math.max(0, outputChannelData.length - totalSamples),
        timestamp_ms: Date.now(),
      });

      return true;
    }
  }

  // utility

  resampleAudioData(float32Array, targetSamples) {
    if (targetSamples === float32Array.length) {
      return float32Array;
    }

    // Apply playback rate by resampling into a new buffer
    const resampledBuffer = new Float32Array(targetSamples);
    const playbackRate = float32Array.length / targetSamples;

    for (let i = 0; i < targetSamples; ++i) {
      const originalIndex = i * playbackRate;
      const start = Math.floor(originalIndex);
      const end = Math.ceil(originalIndex);

      if (start === end || end >= float32Array.length) {
        // If the start and end are the same or out of bounds, just use the start value
        resampledBuffer[i] = float32Array[start];
      } else {
        // Linear interpolation between two samples
        const ratio = originalIndex - start;
        resampledBuffer[i] = float32Array[start] * (1 - ratio) + float32Array[end] * ratio;
      }
    }
    
    return resampledBuffer;
  }

  determinePlaybackRate(availableSamples, targetSamples) {
    let playbackRate = 1.0;
    if (this.playbackRateMin < this.playbackRateMax) {
      // adjust playback rate based on how far we are from the target (with affordance)
      const samplesDelta = availableSamples - targetSamples;
      if (Math.abs(samplesDelta) > this.playbackRateAffordance * targetSamples) {
        if (samplesDelta <= 0) {
          // slow down
          playbackRate = 1.0 + Math.max(-0.975, samplesDelta / targetSamples);
        } else {
          // speed up
          playbackRate = 1.0 / (1.0 - Math.min(0.975, samplesDelta / targetSamples));
        }
      }
      
      playbackRate = Math.min(this.playbackRateMax, Math.max(this.playbackRateMin, playbackRate));
    }
    return playbackRate;
  }
}

registerProcessor('stream_processor', StreamProcessor);
`;
  var script = new Blob([StreamProcessorWorklet], {
    type: "application/javascript"
  });
  var src = URL.createObjectURL(script);
  var StreamProcessorSrc = src;

  // lib/wav_stream_player.js
  var WavStreamPlayer = class {
    /**
     * Creates a new WavStreamPlayer instance
     * @param {{sampleRate?: number}} options
     * @returns {WavStreamPlayer}
     */
    constructor({ sampleRate = 44100 } = {}) {
      this.scriptSrc = StreamProcessorSrc;
      this.sampleRate = sampleRate;
      this.context = null;
      this.stream = null;
      this.analyser = null;
      this.trackSampleOffsets = {};
      this.interruptedTrackIds = {};
      this._audioProcessor = () => {
      };
    }
    /**
     * Connects the audio context and enables output to speakers
     * @returns {Promise<true>}
     */
    async connect(onAudioDataSent) {
      this.context = new AudioContext({ sampleRate: this.sampleRate });
      this._audioProcessor = onAudioDataSent;
      if (this.context.state === "suspended") {
        await this.context.resume();
      }
      try {
        await this.context.audioWorklet.addModule(this.scriptSrc);
      } catch (e) {
        console.error(e);
        throw new Error(`Could not add audioWorklet module: ${this.scriptSrc}`);
      }
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 8192;
      analyser.smoothingTimeConstant = 0.1;
      this.analyser = analyser;
      if (!this.stream) {
        this._start();
      }
      return true;
    }
    /**
     * Gets the current frequency domain data from the playing track
     * @param {"frequency"|"music"|"voice"} [analysisType]
     * @param {number} [minDecibels] default -100
     * @param {number} [maxDecibels] default -30
     * @returns {import('./analysis/audio_analysis.js').AudioAnalysisOutputType}
     */
    getFrequencies(analysisType = "frequency", minDecibels = -100, maxDecibels = -30) {
      if (!this.analyser) {
        throw new Error("Not connected, please call .connect() first");
      }
      return AudioAnalysis.getFrequencies(
        this.analyser,
        this.sampleRate,
        null,
        analysisType,
        minDecibels,
        maxDecibels
      );
    }
    /**
     * Starts audio streaming
     * @private
     * @returns {Promise<true>}
     */
    _start() {
      const streamNode = new AudioWorkletNode(this.context, "stream_processor");
      streamNode.connect(this.context.destination);
      streamNode.port.onmessage = (e) => {
        const { event, data, underrun, timestamp_ms } = e.data;
        if (event === "audio") {
          this._audioProcessor(data, underrun, timestamp_ms);
        } else if (event === "stop") {
          streamNode.disconnect();
          this.stream = null;
        } else if (event === "offset") {
          const { requestId, trackId, offset } = e.data;
          const currentTime = offset / this.sampleRate;
          this.trackSampleOffsets[requestId] = { trackId, offset, currentTime };
        } else if (event === "log") {
          console.log(data);
        }
        ;
      };
      this.analyser.disconnect();
      streamNode.connect(this.analyser);
      this.stream = streamNode;
      return true;
    }
    configure(config) {
      if (this.stream) {
        this.stream.port.postMessage({ event: "configure", config });
      } else {
        throw new Error("Not connected, please call .connect() first");
      }
    }
    /**
     * Adds 16BitPCM data to the currently playing audio stream
     * You can add chunks beyond the current play point and they will be queued for play
     * @param {ArrayBuffer|Int16Array} arrayBuffer
     * @param {string} [trackId]
     * @returns {Int16Array}
     */
    add16BitPCM(arrayBuffer, trackId = "default") {
      if (typeof trackId !== "string") {
        throw new Error(`trackId must be a string`);
      } else if (this.interruptedTrackIds[trackId]) {
        return;
      }
      if (!this.stream) {
        this._start();
      }
      let buffer;
      if (arrayBuffer instanceof Int16Array) {
        buffer = arrayBuffer;
      } else if (arrayBuffer instanceof ArrayBuffer) {
        buffer = new Int16Array(arrayBuffer);
      } else {
        throw new Error(`argument must be Int16Array or ArrayBuffer`);
      }
      this.stream.port.postMessage({ event: "write", buffer, trackId });
      return buffer;
    }
    /**
     * Gets the offset (sample count) of the currently playing stream
     * @param {boolean} [interrupt]
     * @returns {{trackId: string|null, offset: number, currentTime: number}}
     */
    async getTrackSampleOffset(interrupt = false) {
      if (!this.stream) {
        return null;
      }
      const requestId = crypto.randomUUID();
      this.stream.port.postMessage({
        event: interrupt ? "interrupt" : "offset",
        requestId
      });
      let trackSampleOffset;
      while (!trackSampleOffset) {
        trackSampleOffset = this.trackSampleOffsets[requestId];
        await new Promise((r) => setTimeout(() => r(), 1));
      }
      const { trackId } = trackSampleOffset;
      if (interrupt && trackId) {
        this.interruptedTrackIds[trackId] = true;
      }
      return trackSampleOffset;
    }
    /**
     * Strips the current stream and returns the sample offset of the audio
     * @param {boolean} [interrupt]
     * @returns {{trackId: string|null, offset: number, currentTime: number}}
     */
    async interrupt() {
      return this.getTrackSampleOffset(true);
    }
  };
  globalThis.WavStreamPlayer = WavStreamPlayer;

  // lib/worklets/audio_processor.js
  var AudioProcessorWorklet = `
class AudioProcessor extends AudioWorkletProcessor {

  constructor() {
    super();
    this.port.onmessage = this.receive.bind(this);
    this.initialize();
  }

  initialize() {
    this.foundAudio = false;
    this.recording = false;
    this.chunks = [];
  }

  /**
   * Concatenates sampled chunks into channels
   * Format is chunk[Left[], Right[]]
   */
  readChannelData(chunks, channel = -1, maxChannels = 9) {
    let channelLimit;
    if (channel !== -1) {
      if (chunks[0] && chunks[0].length - 1 < channel) {
        throw new Error(
          \`Channel \${channel} out of range: max \${chunks[0].length}\`
        );
      }
      channelLimit = channel + 1;
    } else {
      channel = 0;
      channelLimit = Math.min(chunks[0] ? chunks[0].length : 1, maxChannels);
    }
    const channels = [];
    for (let n = channel; n < channelLimit; n++) {
      const length = chunks.reduce((sum, chunk) => {
        return sum + chunk[n].length;
      }, 0);
      const buffers = chunks.map((chunk) => chunk[n]);
      const result = new Float32Array(length);
      let offset = 0;
      for (let i = 0; i < buffers.length; i++) {
        result.set(buffers[i], offset);
        offset += buffers[i].length;
      }
      channels[n] = result;
    }
    return channels;
  }

  /**
   * Combines parallel audio data into correct format,
   * channels[Left[], Right[]] to float32Array[LRLRLRLR...]
   */
  formatAudioData(channels) {
    if (channels.length === 1) {
      // Simple case is only one channel
      const float32Array = channels[0].slice();
      const meanValues = channels[0].slice();
      return { float32Array, meanValues };
    } else {
      const float32Array = new Float32Array(
        channels[0].length * channels.length
      );
      const meanValues = new Float32Array(channels[0].length);
      for (let i = 0; i < channels[0].length; i++) {
        const offset = i * channels.length;
        let meanValue = 0;
        for (let n = 0; n < channels.length; n++) {
          float32Array[offset + n] = channels[n][i];
          meanValue += channels[n][i];
        }
        meanValues[i] = meanValue / channels.length;
      }
      return { float32Array, meanValues };
    }
  }

  /**
   * Converts 32-bit float data to 16-bit integers
   */
  floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < float32Array.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  /**
   * Retrieves the most recent amplitude values from the audio stream
   * @param {number} channel
   */
  getValues(channel = -1) {
    const channels = this.readChannelData(this.chunks, channel);
    const { meanValues } = this.formatAudioData(channels);
    return { meanValues, channels };
  }

  /**
   * Exports chunks as an audio/wav file
   */
  export() {
    const channels = this.readChannelData(this.chunks);
    const { float32Array, meanValues } = this.formatAudioData(channels);
    const audioData = this.floatTo16BitPCM(float32Array);
    return {
      meanValues: meanValues,
      audio: {
        bitsPerSample: 16,
        channels: channels,
        data: audioData,
      },
    };
  }

  receive(e) {
    const { event, id } = e.data;
    let receiptData = {};
    switch (event) {
      case 'start':
        this.recording = true;
        break;
      case 'stop':
        this.recording = false;
        break;
      case 'clear':
        this.initialize();
        break;
      case 'export':
        receiptData = this.export();
        break;
      case 'read':
        receiptData = this.getValues();
        break;
      default:
        break;
    }
    // Always send back receipt
    this.port.postMessage({ event: 'receipt', id, data: receiptData });
  }

  sendChunk(chunk) {
    const timestamp_ms = Date.now();
    const channels = this.readChannelData([chunk]);
    const { float32Array, meanValues } = this.formatAudioData(channels);
    const rawAudioData = this.floatTo16BitPCM(float32Array);
    const monoAudioData = this.floatTo16BitPCM(meanValues);
    this.port.postMessage({
      event: 'chunk',
      data: {
        mono: monoAudioData,
        raw: rawAudioData,
      },
      timestamp_ms,
    });
  }

  process(inputList, outputList, parameters) {    
    // Copy input to output (e.g. speakers)
    // Note that this creates choppy sounds with Mac products
    const sourceLimit = Math.min(inputList.length, outputList.length);
    for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
      const input = inputList[inputNum];
      const output = outputList[inputNum];
      const channelCount = Math.min(input.length, output.length);
      for (let channelNum = 0; channelNum < channelCount; channelNum++) {
        input[channelNum].forEach((sample, i) => {
          output[channelNum][i] = sample;
        });
      }
    }
    const inputs = inputList[0];
    // There's latency at the beginning of a stream before recording starts
    // Make sure we actually receive audio data before we start storing chunks
    let sliceIndex = 0;
    if (!this.foundAudio) {
      for (const channel of inputs) {
        sliceIndex = 0; // reset for each channel
        if (this.foundAudio) {
          break;
        }
        if (channel) {
          for (const value of channel) {
            if (value !== 0) {
              // find only one non-zero entry in any channel
              this.foundAudio = true;
              break;
            } else {
              sliceIndex++;
            }
          }
        }
      }
    }
    if (inputs && inputs[0] && this.foundAudio && this.recording) {
      // We need to copy the TypedArray, because the \`process\`
      // internals will reuse the same buffer to hold each input
      const chunk = inputs.map((input) => input.slice(sliceIndex));
      this.chunks.push(chunk);
      this.sendChunk(chunk);
    }
    return true;
  }
}

registerProcessor('audio_processor', AudioProcessor);
`;
  var script2 = new Blob([AudioProcessorWorklet], {
    type: "application/javascript"
  });
  var src2 = URL.createObjectURL(script2);
  var AudioProcessorSrc = src2;

  // lib/wav_recorder.js
  var WavRecorder = class {
    /**
     * Create a new WavRecorder instance
     * @param {{sampleRate?: number, outputToSpeakers?: boolean, debug?: boolean}} [options]
     * @returns {WavRecorder}
     */
    constructor({
      sampleRate = 44100,
      outputToSpeakers = false,
      debug = false
    } = {}) {
      this.scriptSrc = AudioProcessorSrc;
      this.sampleRate = sampleRate;
      this.outputToSpeakers = outputToSpeakers;
      this.debug = !!debug;
      this._deviceChangeCallback = null;
      this._devices = [];
      this.stream = null;
      this.processor = null;
      this.source = null;
      this.node = null;
      this.recording = false;
      this._lastEventId = 0;
      this.eventReceipts = {};
      this.eventTimeout = 5e3;
      this._chunkProcessor = () => {
      };
      this._chunkProcessorSize = void 0;
      this._chunkProcessorBuffer = {
        raw: new ArrayBuffer(0),
        mono: new ArrayBuffer(0)
      };
    }
    /**
     * Decodes audio data from multiple formats to a Blob, url, Float32Array and AudioBuffer
     * @param {Blob|Float32Array|Int16Array|ArrayBuffer|number[]} audioData
     * @param {number} sampleRate
     * @param {number} fromSampleRate
     * @returns {Promise<DecodedAudioType>}
     */
    static async decode(audioData, sampleRate = 44100, fromSampleRate = -1) {
      const context = new AudioContext({ sampleRate });
      let arrayBuffer;
      let blob;
      if (audioData instanceof Blob) {
        if (fromSampleRate !== -1) {
          throw new Error(
            `Can not specify "fromSampleRate" when reading from Blob`
          );
        }
        blob = audioData;
        arrayBuffer = await blob.arrayBuffer();
      } else if (audioData instanceof ArrayBuffer) {
        if (fromSampleRate !== -1) {
          throw new Error(
            `Can not specify "fromSampleRate" when reading from ArrayBuffer`
          );
        }
        arrayBuffer = audioData;
        blob = new Blob([arrayBuffer], { type: "audio/wav" });
      } else {
        let float32Array;
        let data;
        if (audioData instanceof Int16Array) {
          data = audioData;
          float32Array = new Float32Array(audioData.length);
          for (let i = 0; i < audioData.length; i++) {
            float32Array[i] = audioData[i] / 32768;
          }
        } else if (audioData instanceof Float32Array) {
          float32Array = audioData;
        } else if (audioData instanceof Array) {
          float32Array = new Float32Array(audioData);
        } else {
          throw new Error(
            `"audioData" must be one of: Blob, Float32Arrray, Int16Array, ArrayBuffer, Array<number>`
          );
        }
        if (fromSampleRate === -1) {
          throw new Error(
            `Must specify "fromSampleRate" when reading from Float32Array, In16Array or Array`
          );
        } else if (fromSampleRate < 3e3) {
          throw new Error(`Minimum "fromSampleRate" is 3000 (3kHz)`);
        }
        if (!data) {
          data = WavPacker.floatTo16BitPCM(float32Array);
        }
        const audio = {
          bitsPerSample: 16,
          channels: [float32Array],
          data
        };
        const packer = new WavPacker();
        const result = packer.pack(fromSampleRate, audio);
        blob = result.blob;
        arrayBuffer = await blob.arrayBuffer();
      }
      const audioBuffer = await context.decodeAudioData(arrayBuffer);
      const values = audioBuffer.getChannelData(0);
      const url = URL.createObjectURL(blob);
      return {
        blob,
        url,
        values,
        audioBuffer
      };
    }
    /**
     * Logs data in debug mode
     * @param {...any} arguments
     * @returns {true}
     */
    log() {
      if (this.debug) {
        this.log(...arguments);
      }
      return true;
    }
    /**
     * Retrieves the current sampleRate for the recorder
     * @returns {number}
     */
    getSampleRate() {
      return this.sampleRate;
    }
    /**
     * Retrieves the current status of the recording
     * @returns {"ended"|"paused"|"recording"}
     */
    getStatus() {
      if (!this.processor) {
        return "ended";
      } else if (!this.recording) {
        return "paused";
      } else {
        return "recording";
      }
    }
    /**
     * Sends an event to the AudioWorklet
     * @private
     * @param {string} name
     * @param {{[key: string]: any}} data
     * @param {AudioWorkletNode} [_processor]
     * @returns {Promise<{[key: string]: any}>}
     */
    async _event(name, data = {}, _processor = null) {
      _processor = _processor || this.processor;
      if (!_processor) {
        throw new Error("Can not send events without recording first");
      }
      const message = {
        event: name,
        id: this._lastEventId++,
        data
      };
      _processor.port.postMessage(message);
      const t0 = (/* @__PURE__ */ new Date()).valueOf();
      while (!this.eventReceipts[message.id]) {
        if ((/* @__PURE__ */ new Date()).valueOf() - t0 > this.eventTimeout) {
          throw new Error(`Timeout waiting for "${name}" event`);
        }
        await new Promise((res) => setTimeout(() => res(true), 1));
      }
      const payload = this.eventReceipts[message.id];
      delete this.eventReceipts[message.id];
      return payload;
    }
    /**
     * Sets device change callback, remove if callback provided is `null`
     * @param {(Array<MediaDeviceInfo & {default: boolean}>): void|null} callback
     * @returns {true}
     */
    listenForDeviceChange(callback) {
      if (callback === null && this._deviceChangeCallback) {
        navigator.mediaDevices.removeEventListener(
          "devicechange",
          this._deviceChangeCallback
        );
        this._deviceChangeCallback = null;
      } else if (callback !== null) {
        let lastId = 0;
        let lastDevices = [];
        const serializeDevices = (devices) => devices.map((d) => d.deviceId).sort().join(",");
        const cb = async () => {
          let id = ++lastId;
          const devices = await this.listDevices();
          if (id === lastId) {
            if (serializeDevices(lastDevices) !== serializeDevices(devices)) {
              lastDevices = devices;
              callback(devices.slice());
            }
          }
        };
        navigator.mediaDevices.addEventListener("devicechange", cb);
        cb();
        this._deviceChangeCallback = cb;
      }
      return true;
    }
    /**
     * Manually request permission to use the microphone
     * @returns {Promise<true>}
     */
    async requestPermission() {
      const permissionStatus = await navigator.permissions.query({
        name: "microphone"
      });
      if (permissionStatus.state === "denied") {
        window.alert("You must grant microphone access to use this feature.");
      } else if (permissionStatus.state === "prompt") {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true
          });
          const tracks = stream.getTracks();
          tracks.forEach((track) => track.stop());
        } catch (e) {
          window.alert("You must grant microphone access to use this feature.");
        }
      }
      return true;
    }
    /**
     * List all eligible devices for recording, will request permission to use microphone
     * @returns {Promise<Array<MediaDeviceInfo & {default: boolean}>>}
     */
    async listDevices() {
      if (!navigator.mediaDevices || !("enumerateDevices" in navigator.mediaDevices)) {
        throw new Error("Could not request user devices");
      }
      await this.requestPermission();
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioDevices = devices.filter(
        (device) => device.kind === "audioinput"
      );
      const defaultDeviceIndex = audioDevices.findIndex(
        (device) => device.deviceId === "default"
      );
      const deviceList = [];
      if (defaultDeviceIndex !== -1) {
        let defaultDevice = audioDevices.splice(defaultDeviceIndex, 1)[0];
        let existingIndex = audioDevices.findIndex(
          (device) => device.groupId === defaultDevice.groupId
        );
        if (existingIndex !== -1) {
          defaultDevice = audioDevices.splice(existingIndex, 1)[0];
        }
        defaultDevice.default = true;
        deviceList.push(defaultDevice);
      }
      return deviceList.concat(audioDevices);
    }
    /**
     * Begins a recording session and requests microphone permissions if not already granted
     * Microphone recording indicator will appear on browser tab but status will be "paused"
     * @param {string} [deviceId] if no device provided, default device will be used
     * @returns {Promise<true>}
     */
    async begin(deviceId) {
      if (this.processor) {
        throw new Error(
          `Already connected: please call .end() to start a new session`
        );
      }
      if (!navigator.mediaDevices || !("getUserMedia" in navigator.mediaDevices)) {
        throw new Error("Could not request user media");
      }
      try {
        const config = { audio: { echoCancellation: true } };
        if (deviceId) {
          config.audio.deviceId = { exact: deviceId };
        }
        this.stream = await navigator.mediaDevices.getUserMedia(config);
        const track = this.stream.getAudioTracks()[0];
        console.log("track-settings", track.getSettings());
      } catch (err) {
        throw new Error("Could not start media stream");
      }
      const context = new AudioContext({ sampleRate: this.sampleRate });
      const source = context.createMediaStreamSource(this.stream);
      try {
        await context.audioWorklet.addModule(this.scriptSrc);
      } catch (e) {
        console.error(e);
        throw new Error(`Could not add audioWorklet module: ${this.scriptSrc}`);
      }
      const processor = new AudioWorkletNode(context, "audio_processor");
      processor.port.onmessage = (e) => {
        const { event, id, data, timestamp_ms } = e.data;
        if (event === "receipt") {
          this.eventReceipts[id] = data;
        } else if (event === "chunk") {
          if (this._chunkProcessorSize) {
            throw new Error("deprecated - chunkSize must be 0 - do not use buffering");
          } else {
            this._chunkProcessor(data, timestamp_ms);
          }
        }
      };
      const node = source.connect(processor);
      const analyser = context.createAnalyser();
      analyser.fftSize = 8192;
      analyser.smoothingTimeConstant = 0.1;
      node.connect(analyser);
      if (this.outputToSpeakers) {
        console.warn(
          "Warning: Output to speakers may affect sound quality,\nespecially due to system audio feedback preventative measures.\nuse only for debugging"
        );
        analyser.connect(context.destination);
      }
      this.source = source;
      this.node = node;
      this.analyser = analyser;
      this.processor = processor;
      return true;
    }
    /**
     * Gets the current frequency domain data from the recording track
     * @param {"frequency"|"music"|"voice"} [analysisType]
     * @param {number} [minDecibels] default -100
     * @param {number} [maxDecibels] default -30
     * @returns {import('./analysis/audio_analysis.js').AudioAnalysisOutputType}
     */
    getFrequencies(analysisType = "frequency", minDecibels = -100, maxDecibels = -30) {
      if (!this.processor) {
        throw new Error("Session ended: please call .begin() first");
      }
      return AudioAnalysis.getFrequencies(
        this.analyser,
        this.sampleRate,
        null,
        analysisType,
        minDecibels,
        maxDecibels
      );
    }
    /**
     * Pauses the recording
     * Keeps microphone stream open but halts storage of audio
     * @returns {Promise<true>}
     */
    async pause() {
      if (!this.processor) {
        throw new Error("Session ended: please call .begin() first");
      } else if (!this.recording) {
        throw new Error("Already paused: please call .record() first");
      }
      this.log("Pausing ...");
      await this._event("stop");
      this.recording = false;
      return true;
    }
    /**
     * Start recording stream and storing to memory from the connected audio source
     * @param {(data: { mono: Int16Array; raw: Int16Array }, timestamp_ms: number) => any} [chunkProcessor]
     * @returns {Promise<true>}
     */
    async record(chunkProcessor = () => {
    }) {
      if (!this.processor) {
        throw new Error("Session ended: please call .begin() first");
      } else if (this.recording) {
        throw new Error("Already recording: please call .pause() first");
      } else if (typeof chunkProcessor !== "function") {
        throw new Error(`chunkProcessor must be a function`);
      }
      this._chunkProcessor = chunkProcessor;
      this._chunkProcessorSize = 0;
      this._chunkProcessorBuffer = {
        raw: new ArrayBuffer(0),
        mono: new ArrayBuffer(0)
      };
      this.log("Recording ...");
      await this._event("start");
      this.recording = true;
      return true;
    }
    /**
     * Clears the audio buffer, empties stored recording
     * @returns {Promise<true>}
     */
    async clear() {
      if (!this.processor) {
        throw new Error("Session ended: please call .begin() first");
      }
      await this._event("clear");
      return true;
    }
    /**
     * Reads the current audio stream data
     * @returns {Promise<{meanValues: Float32Array, channels: Array<Float32Array>}>}
     */
    async read() {
      if (!this.processor) {
        throw new Error("Session ended: please call .begin() first");
      }
      this.log("Reading ...");
      const result = await this._event("read");
      return result;
    }
    /**
     * Saves the current audio stream to a file
     * @param {boolean} [force] Force saving while still recording
     * @returns {Promise<import('./wav_packer.js').WavPackerAudioType>}
     */
    async save(force = false) {
      if (!this.processor) {
        throw new Error("Session ended: please call .begin() first");
      }
      if (!force && this.recording) {
        throw new Error(
          "Currently recording: please call .pause() first, or call .save(true) to force"
        );
      }
      this.log("Exporting ...");
      const exportData = await this._event("export");
      const packer = new WavPacker();
      const result = packer.pack(this.sampleRate, exportData.audio);
      return result;
    }
    /**
     * Ends the current recording session and saves the result
     * @returns {Promise<import('./wav_packer.js').WavPackerAudioType>}
     */
    async end() {
      if (!this.processor) {
        throw new Error("Session ended: please call .begin() first");
      }
      const _processor = this.processor;
      this.log("Stopping ...");
      await this._event("stop");
      this.recording = false;
      const tracks = this.stream.getTracks();
      tracks.forEach((track) => track.stop());
      this.log("Exporting ...");
      const exportData = await this._event("export", {}, _processor);
      this.processor.disconnect();
      this.source.disconnect();
      this.node.disconnect();
      this.analyser.disconnect();
      this.stream = null;
      this.processor = null;
      this.source = null;
      this.node = null;
      const packer = new WavPacker();
      const result = packer.pack(this.sampleRate, exportData.audio);
      return result;
    }
    /**
     * Performs a full cleanup of WavRecorder instance
     * Stops actively listening via microphone and removes existing listeners
     * @returns {Promise<true>}
     */
    async quit() {
      this.listenForDeviceChange(null);
      if (this.processor) {
        await this.end();
      }
      return true;
    }
  };
  globalThis.WavRecorder = WavRecorder;
})();
