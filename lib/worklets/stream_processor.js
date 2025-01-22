// NOTE(apkumar)
//
// This implements a quite simple realtime playback buffering system. It
// exploits the fact that the server often sends exact silence (0s) and that
// this silence can be skipped entirely to catch up and reduce buffering
// latency.
//
// We look at samples in buffers of length `128` (which is hardcoded by the
// definition of the AudioWorkletProcessor). Any buffer that is entirely silence
// is skipped entirely.
//
// We also force that a minimum number of buffers must be present to begin
// playback (of non-silence), so that we're unlikely to run out of real data to
// play. The larger `playbackMinBuffers`, the more latency the user will
// experience before playback of real audio starts. The smaller
// `minBufferToBeginPlayback`, the more likely the user is to experience
// stuttering if a network hitch occurs.

export const StreamProcessorWorklet = `
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
    this.playbackRateMin = 1;
    this.playbackRateMax = 1;
    this.playbackSmoothing = 0;
    this.playbackSkipDigitalSilence = false;
    this.playbackMinBuffers = 16; // 128 * 16 = 2048 samples @ 24kHz = 85ms (2 server frames)
    
    // state
    this.playbackRate = 1;
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
          this.playbackMinBuffers = payload.playbackMinBuffers || this.playbackMinBuffers;
          this.playbackRateMin = payload.playbackRateMin || this.playbackRateMin;
          this.playbackRateMax = payload.playbackRateMax || this.playbackRateMax;
          this.playbackSmoothing = payload.playbackSmoothing || this.playbackSmoothing;
          this.playbackSkipDigitalSilence = payload.playbackSkipDigitalSilence || this.playbackSkipDigitalSilence;
        } else {
          throw new Error('Unhandled event: ' + payload.event);
        }
      }
    };
  }

  writeData(float32Array, trackId = null) {
    // parse to find blocks of audio of the following format: [maybe silence samples | maybe non-silence samples]
    let silenceStartIndex = 0;
    let nonSilenceStartIndex = -1;
    
    for (let i = 0; i < float32Array.length; ++i) {
      const sample = float32Array[i];

      if (sample !== 0) {
        // start of new non-silence block
        if (nonSilenceStartIndex === -1) {
          nonSilenceStartIndex = i;
        }
      } else {
        // end of non-silence block
        if (nonSilenceStartIndex !== -1) {
          const buffer = float32Array.slice(silenceStartIndex, i);
          this.outputBuffers.push({ buffer: buffer, trackId, movedSamples: i - silenceStartIndex, silenceSamples: nonSilenceStartIndex - silenceStartIndex});

          silenceStartIndex = i;
          nonSilenceStartIndex = -1;
        }
      }
    }

    if (nonSilenceStartIndex !== -1) {
      const buffer = float32Array.slice(silenceStartIndex, float32Array.length);
      this.outputBuffers.push({ buffer: buffer, trackId, movedSamples: float32Array.length - silenceStartIndex, silenceSamples: nonSilenceStartIndex - silenceStartIndex});
    } else if (silenceStartIndex < float32Array.length) {
      const buffer = float32Array.slice(silenceStartIndex, float32Array.length);
      this.outputBuffers.push({ buffer: buffer, trackId, movedSamples: float32Array.length - silenceStartIndex, silenceSamples: float32Array.length - silenceStartIndex });
    }

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
      let samplesRead = 0;
      let samplesMoved = 0;
      let samplesWritten = 0

      if (outputBuffers.length > 0) {
        const outputChanneDataSampledNeeded = outputChannelData.length;
        
        // audio buffer book-keeping - we want to buffer server frames of audio
        const serverSamplesTarget = this.playbackMinBuffers * this.bufferLength;
                
        let shouldConsumeBuffer = false;
        let consumableSamples = 0;
        
        if (this.playbackSkipDigitalSilence) {
          // count total buffered after initial non-silence buffer
          for (let i = 0; i < outputBuffers.length; ++i) {
            const { movedSamples, silenceSamples } = outputBuffers[i];
            if (this.isInPlayback || consumableSamples || movedSamples > silenceSamples) {
              consumableSamples += movedSamples;
            }
          }
          
          // consume the buffer if we are already in non-silence playback or if enough non-silence has been buffered
          shouldConsumeBuffer = this.isInPlayback || consumableSamples >= serverSamplesTarget;
        } else {
          for (let i = 0; i < outputBuffers.length; ++i) {
            consumableSamples += outputBuffers[i].movedSamples;
          }
          
          // start consumption once initial buffering is met
          shouldConsumeBuffer = this.hasStarted || consumableSamples >= serverSamplesTarget;
        }

        if (shouldConsumeBuffer) {
          // apply playback rate to determine how many samples are needed
          const playbackRate = 1.0;
          if (this.playbackRateMin < this.playbackRateMax) {
            // only adjust playback rate if we are down to less than half our buffer
            const serverSamplesDelta = consumableSamples - serverSamplesTarget;

            if (Math.abs(serverSamplesDelta) > 0.5 * serverSamplesTarget) {
              if (serverSamplesDelta <= 0) {
                // slow down
                playbackRate = 1.0 + serverSamplesDelta / serverSamplesTarget;
              } else {
                // speed up
                playbackRate = 1.0 / (1.0 - serverSamplesDelta / serverSamplesTarget);
              }
            }
            playbackRate = this.playbackRate = Math.min(this.playbackRateMax, Math.max(this.playbackRateMin, playbackRate));
          }
        
          // this.port.postMessage({ event: 'log', data: { consumableSamples, playbackRate } });
          
          const outputBufferSamplesNeeded = Math.floor(outputChanneDataSampledNeeded * playbackRate);
          const outputBuffer = new Float32Array(outputBufferSamplesNeeded);

          // read the necessary samples from the outputBuffers
          let outputBufferIndex = 0;
          let outputBufferOffset = this.playbackOutputOffset;
          let outputTrackId = null;
          for ( ; outputBufferIndex < outputBuffers.length; ++outputBufferIndex) {
            const { buffer, trackId, movedSamples, silenceSamples } = outputBuffers[outputBufferIndex];

            outputTrackId = trackId;

            // skip full buffers of silence (if enabled)
            if (this.playbackSkipDigitalSilence) {
              if (movedSamples === silenceSamples && outputBufferOffset === 0) {
                samplesMoved += movedSamples;
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
            this.outputBuffers = outputBuffers.slice(outputBufferIndex);
            this.playbackOutputOffset = outputBufferOffset;
          
            if (outputTrackId) {
              this.trackSampleOffsets[outputTrackId] =
                this.trackSampleOffsets[outputTrackId] || 0;
              this.trackSampleOffsets[outputTrackId] += resampledBuffer.length;
            }
          }
        }
      }

      if (samplesMoved > 0) {
        this.hasStarted = true;

        // post audio playback timestamp
        this.port.postMessage({
          event: 'audio',
          data: samplesMoved,
          timestamp_ms: Date.now(),
        });
      }

      if (samplesWritten > 0) {
        this.isInPlayback = true;
      } else {
        this.isInPlayback = false;
      }

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

    // Apply a simple moving average to smooth the entire buffer
    if (this.playbackSmoothing > 0) {
      for (let i = 0; i < targetSamples; ++i) {
        let sum = 0;
        let count = 0;

        // Sum over the window
        for (let j = -smoothingWindow; j <= smoothingWindow; ++j) {
          const idx = i + j;
          if (idx >= 0 && idx < targetSamples) {
            sum += resampledBuffer[idx];
            count++;
          }
        }

        // Calculate the average
        resampledBuffer[i] = sum / count;
      }
    }

    return resampledBuffer;
  }
}

registerProcessor('stream_processor', StreamProcessor);
`;

const script = new Blob([StreamProcessorWorklet], {
  type: 'application/javascript',
});
const src = URL.createObjectURL(script);
export const StreamProcessorSrc = src;
