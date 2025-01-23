export const StreamProcessorWorklet: "\n// StreamProcessor\n\nclass StreamProcessor extends AudioWorkletProcessor {\n  constructor() {\n    super();\n    this.hasStarted = false;\n    this.hasInterrupted = false;\n    this.outputBuffers = [];\n    this.bufferLength = 128;\n    this.writeTrackId = null;\n    \n    // configuration\n    this.playbackRateMin = 1.0;\n    this.playbackRateMax = 1.0;\n    this.playbackRateAffordance = 0.2;\n    this.playbackSmoothing = 0.9;\n    this.playbackSkipDigitalSilence = true;\n    this.playbackMinBuffers = 16; // 16 * 128 samples @ 24kHz ~ 85ms (2 server frames)\n    \n    // state\n    this.playbackRate = 1.0;\n    this.playbackOutputOffset = 0;\n\n    // recording\n    this.playbackRecord = false;\n    this.playbackAudioChunks = [];\n\n    this.isInPlayback = false;\n    \n    this.trackSampleOffsets = {};\n    this.port.onmessage = (event) => {\n      if (event.data) {\n        const payload = event.data;\n        if (payload.event === 'write') {\n          const int16Array = payload.buffer;\n          const float32Array = new Float32Array(int16Array.length);\n          for (let i = 0; i < int16Array.length; i++) {\n            float32Array[i] = int16Array[i] / 0x8000; // Convert Int16 to Float32\n          }\n          this.writeTrackId = payload.trackId;\n          this.writeData(float32Array, payload.trackId);\n        } else if (\n          payload.event === 'offset' ||\n          payload.event === 'interrupt'\n        ) {\n          const requestId = payload.requestId;\n          const trackId = payload.trackId || this.writeTrackId;\n          const offset = this.trackSampleOffsets[trackId] || 0;\n          this.port.postMessage({\n            event: 'offset',\n            requestId,\n            trackId,\n            offset,\n            audio: this.floatTo16BitPCM(this.mergeAudioData(this.playbackAudioChunks))\n          });\n          if (payload.event === 'interrupt') {\n            this.hasInterrupted = true;\n          }\n        } else if (payload.event === 'configure') {\n          const config = {\n            playbackMinBuffers: this.playbackMinBuffers,\n            playbackRateMin: this.playbackRateMin,\n            playbackRateMax: this.playbackRateMax,\n            playbackRateAffordance: this.playbackRateAffordance,\n            playbackSmoothing: this.playbackSmoothing,\n            playbackSkipDigitalSilence: this.playbackSkipDigitalSilence,\n            ...payload.config,\n          };\n\n          // this.port.postMessage({ event: 'log', data: '[worker] Configuring ' + JSON.stringify(config) });\n\n          this.playbackMinBuffers = config.playbackMinBuffers;\n          this.playbackRateMin = config.playbackRateMin;\n          this.playbackRateMax = config.playbackRateMax;\n          this.playbackRateAffordance = config.playbackRateAffordance;\n          this.playbackSmoothing = config.playbackSmoothing;\n          this.playbackSkipDigitalSilence = config.playbackSkipDigitalSilence;\n        } else {\n          throw new Error('Unhandled event: ' + payload.event);\n        }\n      }\n    };\n  }\n\n  writeData(float32Array, trackId = null) {\n    let isSilence = true;\n    for (let i = 0; i < float32Array.length; ++i) {\n      if (float32Array[i] !== 0) {\n        isSilence = false;\n        break;\n      }\n    }\n\n    this.outputBuffers.push({ trackId, buffer: float32Array, isSilence: isSilence });\n\n    // this.port.postMessage({ event: 'log', data: '[worker] Consumed ' + float32Array.length + ' samples (silence: ' + isSilence + ')' });\n    return true;\n  }\n\n  process(inputs, outputs, parameters) {\n    const output = outputs[0];\n    const outputChannelData = output[0];\n    const outputBuffers = this.outputBuffers;\n\n    if (this.hasInterrupted) {\n      this.port.postMessage({ event: 'stop' });\n      return false;\n    } else {\n      let samplesRead = 0;\n      let samplesMoved = 0;\n      let samplesWritten = 0\n\n      if (outputBuffers.length > 0) {\n        const outputChanneDataSampledNeeded = outputChannelData.length;\n        const serverSamplesTarget = this.playbackMinBuffers * this.bufferLength;\n        \n        // determine if we should consume the output buffer        \n        let totalSamples = -this.playbackOutputOffset;\n        let consumableSamples = totalSamples;\n        let shouldConsumeBuffer = false;\n        \n        if (this.playbackSkipDigitalSilence) {\n          // count total buffered after initial non-silence buffer\n          for (let i = 0; i < outputBuffers.length; ++i) {\n            const { buffer, isSilence } = outputBuffers[i];\n            \n            totalSamples += buffer.length;\n            // consider a sample as consumable if we are in or entering playback or if it is non-silence\n            if (this.isInPlayback || consumableSamples > 0 || !isSilence) {\n              consumableSamples += buffer.length;\n            }\n          }\n          \n          // consume samples only if we are already in playback or we've buffered enough\n          shouldConsumeBuffer = this.isInPlayback || consumableSamples >= serverSamplesTarget;\n        } else {\n          for (let i = 0; i < outputBuffers.length; ++i) {\n            consumableSamples += outputBuffers[i].buffer.length;\n          }\n          totalSamples = consumableSamples;\n          \n          // start continuous consumption once initial buffering is met\n          shouldConsumeBuffer = this.hasStarted || consumableSamples >= serverSamplesTarget;\n        }\n\n        if (shouldConsumeBuffer && consumableSamples > 0) {\n          // apply playback rate to determine how many samples to consume\n          const playbackRateTarget = this.determinePlaybackRate(consumableSamples, serverSamplesTarget);\n          this.playbackRate = this.playbackRate * this.playbackSmoothing + playbackRateTarget * (1 - this.playbackSmoothing);\n  \n          const outputBufferSamplesNeeded = Math.floor(outputChanneDataSampledNeeded * this.playbackRate);\n          const outputBuffer = new Float32Array(outputBufferSamplesNeeded);\n\n          // this.port.postMessage({ event: 'log', data: '[worker] Consuming ' + outputBufferSamplesNeeded + ' of ' + consumableSamples + ' samples (total: ' + totalSamples + ') @ ' + this.playbackRate });\n\n          // read the necessary (or as many as available) samples from the outputBuffers\n          let outputBufferIndex = 0;\n          let outputBufferOffset = this.playbackOutputOffset;\n          let outputTrackId = null;\n          while (outputBufferIndex < outputBuffers.length) {\n            const { trackId, buffer, isSilence } = outputBuffers[outputBufferIndex];\n\n            outputTrackId = trackId;\n\n            // skip full buffers of silence (if enabled)\n            if (this.playbackSkipDigitalSilence) {\n              if (isSilence && outputBufferOffset === 0) {\n                samplesMoved += buffer.length;\n                // advance buffer\n                outputBufferIndex++;\n                continue;\n              }\n            }\n\n            // read samples from the buffer\n            for (let j = outputBufferOffset; j < buffer.length && samplesRead < outputBufferSamplesNeeded; ++j) {\n              outputBuffer[samplesRead++] = buffer[j];\n              samplesMoved++;\n              \n              // advance output buffer\n              if (j === buffer.length - 1) {\n                outputBufferOffset = 0;\n                outputBufferIndex++;\n              } else {\n                outputBufferOffset++;\n              }\n            }\n\n            // done if read enough samples\n            if (samplesRead === outputBufferSamplesNeeded) {\n              break;\n            }\n          }\n\n          // done if no samples\n          if (samplesRead > 0) {\n            // apply playback rate to output buffer\n            const resampledBuffer = this.resampleAudioData(outputBuffer, outputChanneDataSampledNeeded);\n            \n            // write the resampled buffer to the output channel\n            for (let i = 0; i < resampledBuffer.length && samplesWritten < outputChanneDataSampledNeeded; ++i) {\n              outputChannelData[samplesWritten++] = resampledBuffer[i];\n            }\n\n            // update output buffers\n            this.outputBuffers = this.outputBuffers.slice(outputBufferIndex);\n            this.playbackOutputOffset = outputBufferOffset;\n          \n            if (outputTrackId) {\n              this.trackSampleOffsets[outputTrackId] =\n                this.trackSampleOffsets[outputTrackId] || 0;\n              this.trackSampleOffsets[outputTrackId] += resampledBuffer.length;\n            }\n          }\n        }\n      }\n\n      if (samplesMoved > 0) {\n        this.hasStarted = true;\n\n        // post audio playback timestamp\n        this.port.postMessage({\n          event: 'audio',\n          data: samplesMoved,\n          timestamp_ms: Date.now(),\n        });\n\n        // append audio chunk and merge if necessary\n        if (this.playbackEnableRecording) {\n          this.playbackAudioChunks.push(outputChannelData.slice(0));\n          if (this.playbackAudioChunks.length > 64) {\n            this.playbackAudioChunks = [this.mergeAudioData(this.playbackAudioChunks)];\n          }\n        }\n      }\n\n      if (samplesWritten > 0) {\n        this.isInPlayback = true;\n      } else {\n        this.isInPlayback = false;\n      }\n\n      return true;\n    }\n  }\n\n  // utility\n\n  determinePlaybackRate(availableSamples, targetSamples) {\n    let playbackRate = 1.0;\n    if (this.playbackRateMin < this.playbackRateMax) {\n      // adjust playback rate based on how far we are from the target (with affordance)\n      const samplesDelta = availableSamples - targetSamples;\n      if (Math.abs(samplesDelta) > this.playbackRateAffordance * targetSamples) {\n        if (samplesDelta <= 0) {\n          // slow down\n          playbackRate = 1.0 + Math.max(-0.975, samplesDelta / targetSamples);\n        } else {\n          // speed up\n          playbackRate = 1.0 / (1.0 - Math.min(0.975, samplesDelta / targetSamples));\n        }\n      }\n      \n      playbackRate = Math.min(this.playbackRateMax, Math.max(this.playbackRateMin, playbackRate));\n    }\n\n    return playbackRate;\n  }\n\n  resampleAudioData(float32Array, targetSamples) {\n    if (targetSamples === float32Array.length) {\n      return float32Array;\n    }\n\n    // Apply playback rate by resampling into a new buffer\n    const resampledBuffer = new Float32Array(targetSamples);\n    const playbackRate = float32Array.length / targetSamples;\n\n    for (let i = 0; i < targetSamples; ++i) {\n      const originalIndex = i * playbackRate;\n      const start = Math.floor(originalIndex);\n      const end = Math.ceil(originalIndex);\n\n      if (start === end || end >= float32Array.length) {\n        // If the start and end are the same or out of bounds, just use the start value\n        resampledBuffer[i] = float32Array[start];\n      } else {\n        // Linear interpolation between two samples\n        const ratio = originalIndex - start;\n        resampledBuffer[i] = float32Array[start] * (1 - ratio) + float32Array[end] * ratio;\n      }\n    }\n    \n    return resampledBuffer;\n  }\n\n  mergeAudioData(float32Arrays) {\n    let samples = 0;\n    for (let i = 0; i < float32Arrays.length; ++i) {\n      samples += float32Arrays[i].length;\n    }\n\n    const merged = new Float32Array(samples);\n    let offset = 0;\n    for (let i = 0; i < float32Arrays.length; ++i) {\n      const chunk = float32Arrays[i];\n      merged.set(chunk, offset);\n      offset += chunk.length;\n    }\n      \n    return merged;\n  }\n\n  floatTo16BitPCM(float32Array) {\n    const buffer = new ArrayBuffer(float32Array.length * 2);\n    const view = new DataView(buffer);\n    let offset = 0;\n    for (let i = 0; i < float32Array.length; i++, offset += 2) {\n      let s = Math.max(-1, Math.min(1, float32Array[i]));\n      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);\n    }\n\n    return buffer;\n  }\n}\n\nregisterProcessor('stream_processor', StreamProcessor);\n";
export const StreamProcessorSrc: any;
//# sourceMappingURL=stream_processor.d.ts.map