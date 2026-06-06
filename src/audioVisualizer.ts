export class AudioVisualizer {
  private audioContext: AudioContext | null = null;
  private animationFrameId: number = 0;

  setup(audioTrack: MediaStreamTrack, canvas: HTMLCanvasElement) {
    this.audioContext = new AudioContext();
    const mediaStream = new MediaStream([audioTrack]);
    const source = this.audioContext.createMediaStreamSource(mediaStream);
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const canvasCtx = canvas.getContext('2d');
    
    const draw = () => {
      if (!canvasCtx) return;
      this.animationFrameId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const average = sum / dataArray.length;
      canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
      canvasCtx.fillStyle = '#4ade80';
      canvasCtx.fillRect(0, 0, (average / 255) * canvas.width, canvas.height);
    };
    draw();
  }

  async stop() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
  }
}
