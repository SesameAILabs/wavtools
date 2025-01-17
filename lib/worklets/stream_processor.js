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
// play. The larger `minBuffersToBeginPlayback`, the more latency the user will
// experience before playback of real audio starts. The smaller
// `minBufferToBeginPlayback`, the more likely the user is to experience
// stuttering if a network hitch occurs.
export const StreamProcessorWorklet = `
class StreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.hasStarted = false;
    this.hasInterrupted = false;
    this.outputBuffers = [];
    this.bufferLength = 128;
    this.write = { buffer: new Float32Array(this.bufferLength), trackId: null };
    this.writeOffset = 0;
    this.minBuffersToBeginPlayback = 15; // 15 * 128 = 1920 samples, ~85ms at 24khz
    this.playbackRate = 1;
    
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
          });
          if (payload.event === 'interrupt') {
            this.hasInterrupted = true;
          }
        } else if (payload.event === 'configure') {
          this.minBuffersToBeginPlayback = payload.minBuffersToBeginPlayback;
          this.playbackRate = payload.playbackRate;
        } else {
          throw new Error(\`Unhandled event "\${payload.event}"\`);
        }
      }
    };
  }

  writeData(float32Array, trackId = null) {

    // here we apply the playback rate

    let { buffer } = this.write;
    let offset = this.writeOffset;

    // Calculate the new length after applying the playback rate
    const resampledLength = Math.floor(float32Array.length / this.playbackRate);
    const resampledArray = new Float32Array(resampledLength);

    // Resample the array based on playbackRate
    for (let i = 0; i < resampledLength; i++) {
      const originalIndex = i * this.playbackRate;
      const start = Math.floor(originalIndex);
      const end = Math.ceil(originalIndex);
      
      if (start === end || end >= float32Array.length) {
        // If the start and end are the same or out of bounds, just use the start value
        resampledArray[i] = float32Array[start];
      } else {
        // Linear interpolation between two samples
        const ratio = originalIndex - start;
        resampledArray[i] = float32Array[start] * (1 - ratio) + float32Array[end] * ratio;
      }
    }

    // Writing the resampled data to the buffer
    for (let i = 0; i < resampledArray.length; i++) {
      buffer[offset++] = resampledArray[i];
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
      let wroteSamples = false;

      while (outputBuffers.length > 0) {
        this.hasStarted = true;

        const { buffer, trackId } = outputBuffers[0];

        // See if this buffer is digital silence. If it is, we skip it entirely.
        let isDigitalSilence = true;
        for (let i = 0; i < buffer.length; i++) {
          if (buffer[i] !== 0) {
            isDigitalSilence = false;
            break;
          }
        }

        // If it's not digital silence, we still may not play it.
        const blockedForPlayback = !this.isInPlayback && outputBuffers.length < this.minBuffersToBeginPlayback;
        if (!isDigitalSilence && blockedForPlayback) {
          break;
        }

        // Otherwise, we're going to consume this buffer.
        samplesMoved += buffer.length;
        outputBuffers.shift();

        // If it's not digital silence, we write.
        if (!isDigitalSilence) {
          for (let i = 0; i < outputChannelData.length; i++) {
            outputChannelData[i] = buffer[i] || 0;
          }

          wroteSamples = true;
        } 

        if (trackId) {
          this.trackSampleOffsets[trackId] =
            this.trackSampleOffsets[trackId] || 0;
          this.trackSampleOffsets[trackId] += buffer.length;
        }

        // If we wrote samples, we're done.
        if (wroteSamples) {
          break;
        }
      }

      // post audio playback timestamp
      if (samplesMoved > 0) {
        this.port.postMessage({
          event: 'audio',
          data: samplesMoved,
          timestamp_ms: Date.now(),
        });
      } 

      if (wroteSamples) {
        this.isInPlayback = true;
      } else {
        this.isInPlayback = false;
      }
      
      return true;
    }
  }
}

registerProcessor('stream_processor', StreamProcessor);
`;

const script = new Blob([StreamProcessorWorklet], {
  type: 'application/javascript',
});
const src = URL.createObjectURL(script);
export const StreamProcessorSrc = src;
