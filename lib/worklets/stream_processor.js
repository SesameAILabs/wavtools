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
    this.playbackRateMin = 1.0;
    this.playbackRateMax = 1.0;
    this.playbackRateAffordance = 0.2;
    this.playbackSmoothing = 0;
    this.playbackSkipDigitalSilence = true;
    this.playbackMinBuffers = 16; // 16 * 128 samples @ 24kHz ~ 85ms (2 server frames)
    
    // state
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
      let samplesRead = 0;
      let samplesMoved = 0;
      let samplesWritten = 0

      if (outputBuffers.length > 0) {
        const outputChanneDataSampledNeeded = outputChannelData.length;
        const serverSamplesTarget = this.playbackMinBuffers * this.bufferLength;
        
        // determine if we should consume the output buffer        
        let totalSamples = -this.playbackOutputOffset;
        let consumableSamples = totalSamples;
        let shouldConsumeBuffer = false;
        
        if (this.playbackSkipDigitalSilence) {
          // count total buffered after initial non-silence buffer
          for (let i = 0; i < outputBuffers.length; ++i) {
            const { buffer, isSilence } = outputBuffers[i];
            
            totalSamples += buffer.length;
            // consider a sample as consumable if we are in or entering playback or if it is non-silence
            if (this.isInPlayback || consumableSamples > 0 || !isSilence) {
              consumableSamples += buffer.length;
            }
          }
          
          // consume samples only if we are already in playback or we've buffered enough
          shouldConsumeBuffer = this.isInPlayback || consumableSamples >= serverSamplesTarget;
        } else {
          for (let i = 0; i < outputBuffers.length; ++i) {
            consumableSamples += outputBuffers[i].buffer.length;
          }
          totalSamples = consumableSamples;
          
          // start continuous consumption once initial buffering is met
          shouldConsumeBuffer = this.hasStarted || consumableSamples >= serverSamplesTarget;
        }

        if (shouldConsumeBuffer && consumableSamples > 0) {
          // apply playback rate to determine how many samples to consume
          const playbackRate = this.determinePlaybackRate(consumableSamples, serverSamplesTarget);
  
          const outputBufferSamplesNeeded = Math.floor(outputChanneDataSampledNeeded * playbackRate);
          const outputBuffer = new Float32Array(outputBufferSamplesNeeded);

          // this.port.postMessage({ event: 'log', data: '[worker] Consuming ' + outputBufferSamplesNeeded + ' of ' + consumableSamples + ' samples (total: ' + totalSamples + ') @ ' + playbackRate });

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

const script = new Blob([StreamProcessorWorklet], {
  type: 'application/javascript',
});
const src = URL.createObjectURL(script);
export const StreamProcessorSrc = src;
