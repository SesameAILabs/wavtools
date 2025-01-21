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
    this.write = { buffer: new Float32Array(this.bufferLength), trackId: null };
    this.writeOffset = 0;

    // configuration
    this.playbackRateMin = 1;
    this.playbackRateMax = 1;
    this.playbackSmoothing = 0;
    this.playbackSkipDigitalSilence = false;
    this.playbackMinBuffers = 12; // 128 * 16 = 2048 samples @ 24kHz = 85ms (2 server frames)
    
    // state
    this.playbackRate = 1;
    this.playbackOutputOffset = 0;

    this.playbackAudioChunks = [];

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
          this.writeData(float32Array, payload.trackId);
        } else if (
          payload.event === 'offset' ||
          payload.event === 'interrupt'
        ) {
          const requestId = payload.requestId;
          const trackId = this.write.trackId;
          const offset = this.trackSampleOffsets[trackId] || 0;
          this.port.postMessage({
            event: 'offset',
            requestId,
            trackId,
            offset,
            audio: this.floatTo16BitPCM(this.mergeAudioData(this.playbackAudioChunks))
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
          throw new Error(\`Unhandled event "\${payload.event}"\`);
        }
      }
    };
  }

  writeData(float32Array, trackId = null) {
    let { buffer } = this.write;
    let offset = this.writeOffset;
    for (let i = 0; i < float32Array.length; i++) {
      buffer[offset++] = float32Array[i];
      if (offset >= buffer.length) {
        this.outputBuffers.push(this.write);
        this.write = { buffer: new Float32Array(this.bufferLength), trackId };
        buffer = this.write.buffer;
        offset = 0;
      }
    }
    this.writeOffset = offset;
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
      let samplesMoved = 0;
      let samplesWritten = 0

      let outputBufferCount = outputBuffers.length;
      
      let iteration = 0;

      while (outputBufferCount > 0) {
        const outputChanneDataSampledNeeded = outputChannelData.length - samplesWritten;
    
        // apply playback rate to determine how many samples are needed
        const playbackRate = this.setPlaybackRate();
        const outputBufferSamplesNeeded = Math.floor(outputChanneDataSampledNeeded * playbackRate);
        const outputBuffer = new Float32Array(outputBufferSamplesNeeded);

        // get the next outputBufferSamplesNeeded samples from outputBuffers
        let outputTrackId = null;

        // read the necessary samples from the outputBuffers
        let samplesRead = 0;
        let outputBufferIndex = 0;
        let outputBufferOffset = this.playbackOutputOffset;
        for ( ; outputBufferIndex < outputBuffers.length; ++outputBufferIndex) {
          const { buffer, trackId } = outputBuffers[outputBufferIndex];

          for (let j = outputBufferOffset; j < buffer.length; ++j) {
            outputBuffer[samplesRead++] = buffer[j];
            
            // advance output buffer
            if (j === buffer.length - 1) {
              outputBufferOffset = 0;
            } else {
              outputBufferOffset = j + 1;
            }
          }

          outputTrackId = trackId;

          // done if read enough samples
          if (samplesRead === outputBufferSamplesNeeded) {
            break;
          }
        }

        // done if no samples read
        if (samplesRead === 0) {
          break;
        }

        this.hasStarted = true;

        // apply playback rate to output buffer
        let resampledBuffer = this.resampleAudioData(outputBuffer, outputChanneDataSampledNeeded);

        // See if this resampledBuffer is digital silence. If it is, we skip it entirely.
        let isDigitalSilence = true;
        for (let i = 0; i < resampledBuffer.length; i++) {
          if (resampledBuffer[i] !== 0) {
            isDigitalSilence = false;
            break;
          }
        }

        // if not yet speaking (but have speech), still need to wait until enough input has been buffered
        const consumeSilence = isDigitalSilence && this.playbackSkipDigitalSilence;
        const consumePlayback = !isDigitalSilence && outputBufferCount >= this.playbackMinBuffers;

        if (!this.isInPlayback && !consumeSilence && !consumePlayback) {
          break;
        }

        // consume this buffer
        samplesMoved += outputBuffer.length;

        this.outputBuffers = outputBuffers.slice(outputBufferIndex);
        this.playbackOutputOffset = outputBufferOffset;

        // If it's not digital silence, we write.
        if (!isDigitalSilence) {
          for (let i = 0; i < resampledBuffer.length; ++i) {
            outputChannelData[samplesWritten++] = resampledBuffer[i];
          }
        }

        if (outputTrackId) {
          this.trackSampleOffsets[outputTrackId] =
            this.trackSampleOffsets[outputTrackId] || 0;
          this.trackSampleOffsets[outputTrackId] += resampledBuffer.length;
        }

        // track buffer count before consuming
        outputBufferCount = outputBuffers.length

        // done if written enough samples
        if (samplesWritten === outputChannelData.length) {
          break;
        }
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
        timestamp_ms: Date.now(),
      });

      // append audio chunk and merge if necessary
      this.playbackAudioChunks.push(outputChannelData);
      if (this.playbackAudioChunks.length > 100) {
        this.playbackAudioChunks = [this.mergeAudioData(this.playbackAudioChunks)];
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

  setPlaybackRate() {
    let playbackRate = 1.0;
    if (this.playbackRateMin < this.playbackRateMax && this.outputBuffers.length > 0) {
      let totalAudioSamples = this.bufferLength * (this.outputBuffers.length - 1) + (this.bufferLength - this.playbackOutputOffset);

      // audio buffer book-keeping - we want to buffer 2 server frames of audio
      const serverSamplesTarget = this.playbackMinBuffers * this.bufferLength;
      const serverSamplesDelta = totalAudioSamples - serverSamplesTarget

      // only adjust playback rate if we are down to less than half our buffer
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
    return playbackRate
  }

  mergeAudioData(float32Arrays) {
    let samples = 0;
    for (let i = 0; i < float32Arrays.length; ++i) {
      samples += float32Arrays[i].length;
    }

    const merged = new Float32Array(samples);
    let offset = 0;
    for (let i = 0; i < float32Arrays.length; ++i) {
      const chunk = float32Arrays[i];
      merged.set(chunk, offset);
      offset += chunk.length;
    }
      
    return merged;
  }

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
}

registerProcessor('stream_processor', StreamProcessor);
`;

const script = new Blob([StreamProcessorWorklet], {
  type: 'application/javascript',
});
const src = URL.createObjectURL(script);
export const StreamProcessorSrc = src;
