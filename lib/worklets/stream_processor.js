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
    this.minBuffersToBeginPlayback = 12; // 12 * 128 = 1536 samples, ~68ms at 24khz
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
