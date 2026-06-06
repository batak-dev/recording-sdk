import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import type { QualityPreset } from './qualityLevels';

export const PERSON_CATEGORY_ID = 1;

export async function initializeSegmenter(): Promise<ImageSegmenter> {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  );

  try {
    console.log('Attempting to initialize ImageSegmenter with GPU delegate...');
    return await ImageSegmenter.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
        delegate: 'GPU'
      },
      runningMode: 'VIDEO',
      outputCategoryMask: true
    });
  } catch {
    console.warn('GPU delegate initialization failed, falling back to CPU. Performance may be degraded on lower-end devices.');
    return await ImageSegmenter.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
        delegate: 'CPU'
      },
      runningMode: 'VIDEO',
      outputCategoryMask: true
    });
  }
}

export function applyBackgroundEffect(
  frame: VideoFrame,
  segmenter: ImageSegmenter,
  videoWidth: number,
  videoHeight: number,
  qualityPreset: QualityPreset
): VideoFrame | null {
  const currentTimestamp = frame.timestamp ?? 0;
  
  // Segment the frame (Timestamp must be in MS)
  const result = segmenter.segmentForVideo(frame, currentTimestamp / 1000);
  const mask = result.categoryMask;

  if (!mask) {
    return null;
  }

  // Create canvases for processing
  const fgCanvas = new OffscreenCanvas(videoWidth, videoHeight);
  const fgCtx = fgCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  
  const bgCanvas = new OffscreenCanvas(videoWidth, videoHeight);
  const bgCtx = bgCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  
  const finalCanvas = new OffscreenCanvas(videoWidth, videoHeight);
  const finalCtx = finalCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;

  const maskImageData = new ImageData(videoWidth, videoHeight);

  // Apply background effects based on quality preset
  if (qualityPreset.pixelateBackground) {
    // Create Background Layer (Pixelated + optionally Grayscale)
    const sw = videoWidth * qualityPreset.pixelationScale;
    const sh = videoHeight * qualityPreset.pixelationScale;
    
    if (qualityPreset.grayscaleBackground) {
      bgCtx.filter = 'grayscale(100%)';
    }
    bgCtx.drawImage(frame, 0, 0, sw, sh);
    
    finalCtx.clearRect(0, 0, videoWidth, videoHeight);
    finalCtx.imageSmoothingEnabled = false;
    finalCtx.drawImage(bgCanvas, 0, 0, sw, sh, 0, 0, videoWidth, videoHeight);
  } else if (qualityPreset.grayscaleBackground) {
    // Grayscale only (no pixelation)
    bgCtx.filter = 'grayscale(100%)';
    bgCtx.drawImage(frame, 0, 0, videoWidth, videoHeight);
    
    finalCtx.clearRect(0, 0, videoWidth, videoHeight);
    finalCtx.drawImage(bgCanvas, 0, 0);
  } else {
    // No background effect - use original
    finalCtx.clearRect(0, 0, videoWidth, videoHeight);
    finalCtx.drawImage(frame, 0, 0);
  }

  // Create Foreground Layer (Person Mask)
  const maskArray = mask.getAsUint8Array();
  for (let i = 0; i < maskArray.length; i++) {
    const category = maskArray[i];
    const isPerson = category === PERSON_CATEGORY_ID || category === 255;
    maskImageData.data[i * 4 + 3] = isPerson ? 0 : 255; // Person = opaque, Background = transparent
  }
  fgCtx.clearRect(0, 0, videoWidth, videoHeight);
  fgCtx.putImageData(maskImageData, 0, 0);

  // Cut the original frame into the mask shape
  fgCtx.globalCompositeOperation = 'source-in';
  fgCtx.drawImage(frame, 0, 0);
  fgCtx.globalCompositeOperation = 'source-over';

  // Combine Foreground over Background
  finalCtx.drawImage(fgCanvas, 0, 0);

  // Create new compressed AI frame
  const processedFrame = new VideoFrame(finalCanvas, { 
    timestamp: currentTimestamp,
    alpha: 'discard'
  });

  // CRITICAL MEMORY CLEANUP
  mask.close();

  return processedFrame;
}
