export function wav(samples: Int16Array): Uint8Array {
  if (samples.length < 1600 || samples.length > 240000)
    throw new Error("Recording length unavailable");
  const bytes = new Uint8Array(44 + samples.length * 2),
    v = new DataView(bytes.buffer);
  for (const [offset, text] of [
    [0, "RIFF"],
    [8, "WAVEfmt "],
    [36, "data"],
  ] as const)
    for (let i = 0; i < text.length; i++)
      bytes[offset + i] = text.charCodeAt(i);
  v.setUint32(4, bytes.length - 8, true);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++)
    v.setInt16(44 + i * 2, samples[i]!, true);
  return bytes;
}
export class Microphone {
  private stream: MediaStream | undefined;
  private context: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private samples = new Int16Array(240000);
  private count = 0;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  async start(onLimit: () => void) {
    this.cancel();
    const generation = this.generation;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true },
        video: false,
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      this.stream = stream;
      const context = new AudioContext();
      this.context = context;
      await context.audioWorklet.addModule("/capture-worklet.js");
      if (generation !== this.generation) return false;
      const node = new AudioWorkletNode(context, "learning-capture");
      this.node = node;
      node.port.onmessage = ({ data }: MessageEvent<Int16Array>) => {
        if (generation !== this.generation || !(data instanceof Int16Array))
          return;
        const n = Math.min(data.length, this.samples.length - this.count);
        this.samples.set(data.subarray(0, n), this.count);
        this.count += n;
      };
      context.createMediaStreamSource(stream).connect(node);
      node.connect(context.destination);
      await context.resume();
      if (generation !== this.generation) return false;
      this.timer = setTimeout(onLimit, 15000);
      return true;
    } catch {
      // A newer start/cancel already released this generation's resources.
      // Its late failure must not cancel or report failure for the new capture.
      if (generation !== this.generation) return false;
      this.cancel();
      throw new Error("Microphone unavailable");
    }
  }
  stop() {
    const data = this.samples.slice(0, this.count);
    this.cancel();
    try {
      return wav(data);
    } finally {
      data.fill(0);
    }
  }
  cancel() {
    this.generation++;
    clearTimeout(this.timer);
    this.node?.disconnect();
    if (this.node) this.node.port.onmessage = null;
    this.node = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    void this.context?.close().catch(() => {});
    this.context = undefined;
    this.samples.fill(0);
    this.count = 0;
  }
}
