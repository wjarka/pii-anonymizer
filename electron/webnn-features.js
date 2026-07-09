const WEBNN_FEATURE = 'WebMachineLearningNeuralNetwork';
const WINDOWS_WEBNN_FEATURE = 'WebNNOnnxRuntime';

export function configureWebnnFeatures(commandLine, platform = process.platform) {
  const features = new Set(
    commandLine.getSwitchValue('enable-features')
      .split(',')
      .map((feature) => feature.trim())
      .filter(Boolean),
  );
  features.add(WEBNN_FEATURE);
  if (platform === 'win32') features.add(WINDOWS_WEBNN_FEATURE);

  const configured = [...features];
  commandLine.removeSwitch('enable-features');
  commandLine.appendSwitch('enable-features', configured.join(','));
  return configured;
}
