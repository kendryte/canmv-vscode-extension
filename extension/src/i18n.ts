import * as vscode from 'vscode';

export const t = vscode.l10n.t;

export const states = {
  disconnected: () => t('Disconnected'),
  connecting: () => t('Connecting...'),
  disconnecting: () => t('Disconnecting...'),
  preparing: () => t('Preparing...'),
  connected: () => t('Connected'),
  streaming: () => t('Streaming'),
  offline: () => t('Offline'),
  ready: () => t('Ready'),
  running: () => t('Running'),
  canmvBoard: () => t('CanMV Board'),
};

export function tr(message: string, args?: Record<string, string | number | boolean>): string {
  return args ? t(message, args) : t(message);
}

export function injectWebviewStrings(html: string): string {
  const script = `<script>window.__CANMV_L10N__=${jsonForScript(webviewStrings())};</script>`;
  return html.includes('</head>')
    ? html.replace('</head>', `${script}\n</head>`)
    : `${script}\n${html}`;
}

export function webviewStrings() {
  return {
    stateDisconnected: states.disconnected(),
    stateConnecting: states.connecting(),
    stateDisconnecting: states.disconnecting(),
    statePreparing: states.preparing(),
    stateConnected: states.connected(),
    stateStreaming: states.streaming(),
    stateOffline: states.offline(),
    stateReady: states.ready(),
    stateRunning: states.running(),
    canmvBoard: states.canmvBoard(),
    terminalTitle: t('CanMV Terminal'),
    monitoring: t('Monitoring'),
    viewMode: t('View Mode'),
    text: t('Text'),
    source: t('Source'),
    saveLog: t('Save Log'),
    clear: t('Clear'),
    clearOutput: t('Clear Output'),
    connectReplInput: t('Connect board to use REPL input'),
    replInputUnavailable: t('REPL input unavailable'),
    previewTitle: t('CanMV Preview'),
    imageEmpty: t('Image: --'),
    imageDecodeError: t('Image: decode error'),
    fpsEmpty: t('FPS: --'),
    fpsLabel: t('FPS: {value}', { value: '{value}' }),
    fpsWithFrameCount: t('FPS: {value} (fc:{frameCount})', { value: '{value}', frameCount: '{frameCount}' }),
    disablePreview: t('Disable Preview'),
    enablePreview: t('Enable Preview'),
    showOriginalSize: t('Show Original Size'),
    fitToWindow: t('Fit to Window'),
    rotateFrame: t('Rotate Frame'),
    saveImage: t('Save Image'),
    pickPixelValue: t('Pick Pixel Value'),
    selectHistogramRoi: t('Select Histogram ROI'),
    recordVideo: t('Record Video'),
    stopRecording: t('Stop Recording'),
    histogram: t('Histogram'),
    histogramColorSpace: t('Histogram color space'),
    rgbColorSpace: t('RGB Color Space'),
    grayscaleColorSpace: t('Grayscale Color Space'),
    labColorSpace: t('LAB Color Space'),
    yuvColorSpace: t('YUV Color Space'),
    none: t('None'),
    fit: t('Fit'),
    histogramTooltip: t('Count {count} ({label} {position})', { count: '{count}', label: '{label}', position: '{position}' }),
    pixelReadout: t('X:{x} Y:{y} RGB({r},{g},{b})', { x: '{x}', y: '{y}', r: '{r}', g: '{g}', b: '{b}' }),
    roiReadout: t('ROI x:{x} y:{y} w:{w} h:{h}', { x: '{x}', y: '{y}', w: '{w}', h: '{h}' }),
    recordingUnavailable: t('Video recording is unavailable in this webview'),
    recordingFailed: t('Recording failed'),
    recordingStarted: t('Recording {format}', { format: '{format}' }),
    recordingSaved: t('Recording ready ({format})', { format: '{format}' }),
    statMean: t('Mean'),
    statMedian: t('Median'),
    statMode: t('Mode'),
    statStdev: t('StDev'),
    statMin: t('Min'),
    statMax: t('Max'),
    statLq: t('LQ'),
    statUq: t('UQ'),
    thresholdEditorTitle: t('Threshold Editor'),
    openImageFile: t('Open Image File'),
    open: t('Open'),
    frameBuffer: t('Frame Buffer'),
    loadLatestPreviewFrame: t('Load latest Preview frame'),
    reset: t('Reset'),
    resetSliders: t('Reset sliders'),
    noImageLoaded: t('No image loaded'),
    sourceImage: t('Source Image'),
    binaryImage: t('Binary Image (white pixels are tracked pixels)'),
    thresholdColorSpace: t('Threshold color space'),
    grayscale: t('Grayscale'),
    lab: t('LAB'),
    invert: t('Invert'),
    grayscaleMin: t('Grayscale Min'),
    grayscaleMax: t('Grayscale Max'),
    lMin: t('L Min'),
    lMax: t('L Max'),
    aMin: t('A Min'),
    aMax: t('A Max'),
    bMin: t('B Min'),
    bMax: t('B Max'),
    grayscaleThreshold: t('Grayscale Threshold'),
    labThreshold: t('LAB Threshold'),
    copy: t('Copy'),
    apply: t('Apply'),
    copyThresholdTuple: t('Copy threshold tuple'),
    replaceSelectedThresholdTuple: t('Replace selected threshold tuple'),
    dropImageFile: t('Drop an image file to load it'),
    previewFrame: t('Preview Frame'),
    noPreviewFrameAvailable: t('No preview frame available'),
    copiedThreshold: t('Copied threshold'),
    updatedSelectedTuple: t('Updated selected tuple'),
    image: t('Image'),
    unableToLoadImage: t('Unable to load image'),
    invalidPpmImage: t('Invalid PPM image'),
  };
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
