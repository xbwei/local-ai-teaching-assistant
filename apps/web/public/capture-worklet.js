/* Original bounded mono 16 kHz sampler. No network or persistent buffers. */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;
    this.count = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || this.count >= 240000) return true;
    const values = [];
    for (const sample of channel) {
      this.phase += 16000;
      if (this.phase >= sampleRate && this.count < 240000) {
        this.phase -= sampleRate;
        values.push(Math.max(-1, Math.min(1, sample)) * 32767);
        this.count++;
      }
    }
    if (values.length) this.port.postMessage(new Int16Array(values));
    return true;
  }
}
registerProcessor("learning-capture", CaptureProcessor);
