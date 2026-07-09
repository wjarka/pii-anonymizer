import { expect, it, vi } from 'vitest';

async function loadConfigureWebnnFeatures() {
  const modulePath = './webnn-features.js';
  let webnnFeatures;
  try {
    webnnFeatures = await import(/* @vite-ignore */ modulePath);
  } catch (error) {
    expect.fail(
      `Expected electron/webnn-features.js to export configureWebnnFeatures, but the module could not be loaded: ${error.message}`
    );
  }
  expect(
    webnnFeatures.configureWebnnFeatures,
    'electron/webnn-features.js must export configureWebnnFeatures'
  ).toBeTypeOf('function');
  return webnnFeatures.configureWebnnFeatures;
}

function fakeCommandLine(initial = '') {
  let value = initial;
  return {
    getSwitchValue: vi.fn(() => value),
    removeSwitch: vi.fn(() => { value = ''; }),
    appendSwitch: vi.fn((_name, next) => { value = next; }),
  };
}

it.each(['darwin', 'linux'])(
  'enables WebNN on %s when no Chromium features are configured',
  async (platform) => {
    const configureWebnnFeatures = await loadConfigureWebnnFeatures();
    const commandLine = fakeCommandLine();

    expect(configureWebnnFeatures(commandLine, platform)).toEqual([
      'WebMachineLearningNeuralNetwork',
    ]);
    expect(commandLine.appendSwitch).toHaveBeenCalledWith(
      'enable-features',
      'WebMachineLearningNeuralNetwork'
    );
  }
);

it('enables WebNN while preserving existing Chromium features', async () => {
  const configureWebnnFeatures = await loadConfigureWebnnFeatures();
  const commandLine = fakeCommandLine('ExistingFeature');

  expect(configureWebnnFeatures(commandLine, 'darwin')).toEqual([
    'ExistingFeature',
    'WebMachineLearningNeuralNetwork',
  ]);
  expect(commandLine.appendSwitch).toHaveBeenCalledWith(
    'enable-features',
    'ExistingFeature,WebMachineLearningNeuralNetwork'
  );
});

it('adds both Windows WebNN features when no Chromium features are configured', async () => {
  const configureWebnnFeatures = await loadConfigureWebnnFeatures();
  const commandLine = fakeCommandLine();

  const features = configureWebnnFeatures(commandLine, 'win32');
  expect(features).toEqual([
    'WebMachineLearningNeuralNetwork',
    'WebNNOnnxRuntime',
  ]);
  expect(features.filter((feature) => feature === 'WebMachineLearningNeuralNetwork')).toHaveLength(1);
  expect(features.filter((feature) => feature === 'WebNNOnnxRuntime')).toHaveLength(1);
  expect(commandLine.appendSwitch).toHaveBeenCalledWith(
    'enable-features',
    'WebMachineLearningNeuralNetwork,WebNNOnnxRuntime'
  );
});

it('preserves existing features without duplicating a user-supplied WebNN base feature on Windows', async () => {
  const configureWebnnFeatures = await loadConfigureWebnnFeatures();
  const commandLine = fakeCommandLine('ExistingFeature,WebMachineLearningNeuralNetwork');

  const features = configureWebnnFeatures(commandLine, 'win32');
  expect(features).toEqual([
    'ExistingFeature',
    'WebMachineLearningNeuralNetwork',
    'WebNNOnnxRuntime',
  ]);
  expect(features.filter((feature) => feature === 'WebMachineLearningNeuralNetwork')).toHaveLength(1);
  expect(features.filter((feature) => feature === 'WebNNOnnxRuntime')).toHaveLength(1);
  expect(commandLine.appendSwitch).toHaveBeenCalledWith(
    'enable-features',
    'ExistingFeature,WebMachineLearningNeuralNetwork,WebNNOnnxRuntime'
  );
});
