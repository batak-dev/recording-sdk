export type NetworkQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'offline';

export interface NetworkStats {
  quality: NetworkQuality;
  throughputKbps: number;
  averageThroughputKbps: number;
  rtt?: number;
  isOnline: boolean;
}

export interface NetworkMonitorOptions {
  onMeasurement?: (stats: NetworkStats) => void; // fires on EVERY measurement (resilience time-series)
  probeUrl?: string;     // base URL of the recording-service for the real upload probe
  forceProbe?: boolean;  // always probe, even if the Network Information API reports downlink
}

export class NetworkMonitor {
  private measurements: number[] = [];
  private maxMeasurements = 10; // Keep last 10 measurements
  private testInterval: number | null = null;
  private onQualityChange?: (stats: NetworkStats) => void;
  private onMeasurement?: (stats: NetworkStats) => void;
  private probeUrl?: string;
  private forceProbe: boolean;
  private currentQuality: NetworkQuality = 'excellent';
  private isMonitoring = false;
  private testChunkSize = 50000; // 50KB test chunks
  private isOnline = navigator.onLine;
  private onlineListener?: () => void;
  private offlineListener?: () => void;

  constructor(onQualityChange?: (stats: NetworkStats) => void, options: NetworkMonitorOptions = {}) {
    this.onQualityChange = onQualityChange;
    this.onMeasurement = options.onMeasurement;
    this.probeUrl = options.probeUrl;
    this.forceProbe = options.forceProbe ?? false;
    this.setupOnlineOfflineListeners();
  }

  /**
   * Setup online/offline event listeners
   */
  private setupOnlineOfflineListeners() {
    this.onlineListener = () => {
      console.log('Network: Online');
      this.isOnline = true;
      
      // Resume monitoring if it was running
      if (this.isMonitoring) {
        this.measureThroughput();
      }
      
      // Notify of online status
      if (this.onQualityChange) {
        const averageThroughput = this.getAverageThroughput();
        const newQuality = this.determineQuality(averageThroughput);
        this.currentQuality = newQuality;
        
        this.onQualityChange({
          quality: newQuality,
          throughputKbps: this.measurements[this.measurements.length - 1] || 0,
          averageThroughputKbps: averageThroughput,
          isOnline: true
        });
      }
    };

    this.offlineListener = () => {
      console.log('Network: Offline');
      this.isOnline = false;
      this.currentQuality = 'offline';
      
      // Notify of offline status
      if (this.onQualityChange) {
        this.onQualityChange({
          quality: 'offline',
          throughputKbps: 0,
          averageThroughputKbps: 0,
          isOnline: false
        });
      }
    };

    window.addEventListener('online', this.onlineListener);
    window.addEventListener('offline', this.offlineListener);
    
    // Check initial state
    if (!navigator.onLine) {
      this.isOnline = false;
      this.currentQuality = 'offline';
    }
  }

  async start(intervalMs: number = 3000) {
    if (this.isMonitoring) return;
    this.isMonitoring = true;
    
    // Initial measurement
    await this.measureThroughput();
    
    // Periodic measurements
    this.testInterval = window.setInterval(async () => {
      if (this.isMonitoring) {
        await this.measureThroughput();
      }
    }, intervalMs);
  }

  stop() {
    this.isMonitoring = false;
    if (this.testInterval !== null) {
      clearInterval(this.testInterval);
      this.testInterval = null;
    }
    
    // Remove event listeners
    if (this.onlineListener) {
      window.removeEventListener('online', this.onlineListener);
    }
    if (this.offlineListener) {
      window.removeEventListener('offline', this.offlineListener);
    }
  }

  private async measureThroughput() {
    // Skip measurement if offline
    if (!this.isOnline || !navigator.onLine) {
      return;
    }
    
    try {
      // Use Navigation Timing API and Network Information API
      const connection = (navigator as any).connection || 
                        (navigator as any).mozConnection || 
                        (navigator as any).webkitConnection;
      
      let throughputKbps = 0;

      // Method 1: Use Network Information API if available (unless a real probe is forced).
      if (connection?.downlink && !this.forceProbe) {
        // downlink is in Mbps, convert to Kbps
        // Estimate upload as ~40% of download (typical asymmetric connection)
        throughputKbps = connection.downlink * 1000 * 0.4;
      } else {
        // Method 2: Measure actual upload speed with a small test
        throughputKbps = await this.performUploadTest();
      }

      this.measurements.push(throughputKbps);
      if (this.measurements.length > this.maxMeasurements) {
        this.measurements.shift();
      }

      const averageThroughput = this.getAverageThroughput();
      const newQuality = this.determineQuality(averageThroughput);

      const stats: NetworkStats = {
        quality: newQuality,
        throughputKbps,
        averageThroughputKbps: averageThroughput,
        rtt: connection?.rtt,
        isOnline: this.isOnline
      };

      // Resilience instrumentation: report every measurement (not just on change).
      if (this.onMeasurement) {
        this.onMeasurement(stats);
      }

      // Only trigger callback if quality changed
      if (newQuality !== this.currentQuality) {
        console.log(`Network quality changed: ${this.currentQuality} -> ${newQuality} (${averageThroughput.toFixed(0)} Kbps)`);
        this.currentQuality = newQuality;
        if (this.onQualityChange) {
          this.onQualityChange(stats);
        }
      }
    } catch (error) {
      console.error('Network measurement error:', error);
    }
  }

  private async performUploadTest(): Promise<number> {
    // Create a small random blob to upload as the throughput probe.
    const testData = new Uint8Array(this.testChunkSize);
    crypto.getRandomValues(testData);
    const blob = new Blob([testData]);

    // Without a configured probe endpoint there is nothing meaningful to measure;
    // assume moderate speed rather than fabricating a number from a fake delay.
    if (!this.probeUrl) {
      return 1500; // 1.5 Mbps
    }

    const endpoint = `${this.probeUrl.replace(/\/$/, '')}/api/v0/public/probe`;
    const startTime = performance.now();

    try {
      await fetch(endpoint, {
        method: 'POST',
        body: blob,
        signal: AbortSignal.timeout(5000)
      });

      const durationSeconds = (performance.now() - startTime) / 1000;
      if (durationSeconds <= 0) return 10000;
      const kbps = (this.testChunkSize * 8) / durationSeconds / 1000;
      // Clamp to a sane ceiling (the 50KB probe can't resolve very high bandwidths).
      return Math.min(kbps, 10000);
    } catch {
      // Network error / timeout: treat as good so we don't needlessly degrade quality.
      return 1500;
    }
  }

  private getAverageThroughput(): number {
    if (this.measurements.length === 0) return 0;
    const sum = this.measurements.reduce((a, b) => a + b, 0);
    return sum / this.measurements.length;
  }

  private determineQuality(throughputKbps: number): NetworkQuality {
    // Quality thresholds based on video bitrate requirements
    // Excellent: > 3 Mbps (can handle high quality)
    // Good: 1.5 - 3 Mbps (can handle medium quality)
    // Fair: 500 Kbps - 1.5 Mbps (need compression)
    // Poor: < 500 Kbps (aggressive compression)
    
    if (throughputKbps >= 3000) return 'excellent';
    if (throughputKbps >= 1500) return 'good';
    if (throughputKbps >= 500) return 'fair';
    return 'poor';
  }

  getCurrentQuality(): NetworkQuality {
    return this.currentQuality;
  }

  getCurrentStats(): NetworkStats {
    return {
      quality: this.currentQuality,
      throughputKbps: this.measurements[this.measurements.length - 1] || 0,
      averageThroughputKbps: this.getAverageThroughput(),
      isOnline: this.isOnline
    };
  }
}
