export const StreamProcessorWorklet: "\nclass StreamProcessor extends AudioWorkletProcessor {\n  constructor() {\n    super();\n    this.hasStarted = false;\n    this.hasInterrupted = false;\n    this.outputBuffers = [];\n    this.bufferLength = 128;\n    this.write = { buffer: new Float32Array(this.bufferLength), trackId: null };\n    this.writeOffset = 0;\n    this.minBuffersToBeginPlayback = 12; // 12 * 128 = 1536 samples, ~68ms at 24khz\n    this.isInPlayback = false;\n    this.trackSampleOffsets = {};\n    this.port.onmessage = (event) => {\n      if (event.data) {\n        const payload = event.data;\n        if (payload.event === 'write') {\n          const int16Array = payload.buffer;\n          const float32Array = new Float32Array(int16Array.length);\n          for (let i = 0; i < int16Array.length; i++) {\n            float32Array[i] = int16Array[i] / 0x8000; // Convert Int16 to Float32\n          }\n          this.writeData(float32Array, payload.trackId);\n        } else if (\n          payload.event === 'offset' ||\n          payload.event === 'interrupt'\n        ) {\n          const requestId = payload.requestId;\n          const trackId = this.write.trackId;\n          const offset = this.trackSampleOffsets[trackId] || 0;\n          this.port.postMessage({\n            event: 'offset',\n            requestId,\n            trackId,\n            offset,\n          });\n          if (payload.event === 'interrupt') {\n            this.hasInterrupted = true;\n          }\n        } else {\n          throw new Error(`Unhandled event \"${payload.event}\"`);\n        }\n      }\n    };\n  }\n\n  writeData(float32Array, trackId = null) {\n    let { buffer } = this.write;\n    let offset = this.writeOffset;\n    for (let i = 0; i < float32Array.length; i++) {\n      buffer[offset++] = float32Array[i];\n      if (offset >= buffer.length) {\n        this.outputBuffers.push(this.write);\n        this.write = { buffer: new Float32Array(this.bufferLength), trackId };\n        buffer = this.write.buffer;\n        offset = 0;\n      }\n    }\n    this.writeOffset = offset;\n    return true;\n  }\n\n  process(inputs, outputs, parameters) {\n    const output = outputs[0];\n    const outputChannelData = output[0];\n    const outputBuffers = this.outputBuffers;\n    if (this.hasInterrupted) {\n      this.port.postMessage({ event: 'stop' });\n      return false;\n    } else {\n      let samplesMoved = 0;\n      let wroteSamples = false;\n\n      while (outputBuffers.length > 0) {\n        this.hasStarted = true;\n\n        const { buffer, trackId } = outputBuffers[0];\n\n        // See if this buffer is digital silence. If it is, we skip it entirely.\n        let isDigitalSilence = true;\n        for (let i = 0; i < buffer.length; i++) {\n          if (buffer[i] !== 0) {\n            isDigitalSilence = false;\n            break;\n          }\n        }\n\n        // If it's not digital silence, we still may not play it.\n        const blockedForPlayback = !this.isInPlayback && outputBuffers.length < this.minBuffersToBeginPlayback;\n        if (!isDigitalSilence && blockedForPlayback) {\n          break;\n        }\n\n        // Otherwise, we're going to consume this buffer.\n        samplesMoved += buffer.length;\n        outputBuffers.shift();\n\n        // If it's not digital silence, we write.\n        if (!isDigitalSilence) {\n          for (let i = 0; i < outputChannelData.length; i++) {\n            outputChannelData[i] = buffer[i] || 0;\n          }\n\n          wroteSamples = true;\n        } \n\n        if (trackId) {\n          this.trackSampleOffsets[trackId] =\n            this.trackSampleOffsets[trackId] || 0;\n          this.trackSampleOffsets[trackId] += buffer.length;\n        }\n\n        // If we wrote samples, we're done.\n        if (wroteSamples) {\n          break;\n        }\n      }\n\n      // post audio playback timestamp\n      if (samplesMoved > 0) {\n        this.port.postMessage({\n          event: 'audio',\n          data: samplesMoved,\n          timestamp_ms: Date.now(),\n        });\n      } \n\n      if (wroteSamples) {\n        this.isInPlayback = true;\n      } else {\n        this.isInPlayback = false;\n      }\n      \n      return true;\n    }\n  }\n}\n\nregisterProcessor('stream_processor', StreamProcessor);\n";
export const StreamProcessorSrc: any;
//# sourceMappingURL=stream_processor.d.ts.map