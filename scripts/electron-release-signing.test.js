import { existsSync, readFileSync } from 'node:fs';

const builderConfig = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
const ciBuilderConfigUrl = new URL('../electron-builder-ci.yml', import.meta.url);
const ciBuilderConfig = existsSync(ciBuilderConfigUrl)
  ? readFileSync(ciBuilderConfigUrl, 'utf8')
  : null;
const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/electron-release.yml', import.meta.url),
  'utf8',
);

function topLevelSection(source, name) {
  return source.match(
    new RegExp(`^${name}:\\r?\\n(?:(?:[ \\t]+[^\\r\\n]*)?\\r?\\n)*`, 'm'),
  )?.[0] ?? '';
}

function jobSection(source, name) {
  return source.match(
    new RegExp(`^  ${name}:\\r?\\n(?:(?: {4,}[^\\r\\n]*)?\\r?\\n)*`, 'm'),
  )?.[0] ?? '';
}

function matrixEntry(source, label) {
  return source.match(
    new RegExp(`^          - label: ${label}\\r?\\n(?:(?: {12,}[^\\r\\n]*)?\\r?\\n)*`, 'm'),
  )?.[0] ?? '';
}

describe('macOS release signing defenses', () => {
  it('isolates the CI ad-hoc signing fallback from the shared builder config', () => {
    const sharedMacConfig = topLevelSection(builderConfig, 'mac');

    expect(sharedMacConfig).not.toMatch(/^  identity: (?:'-'|"-")\s*$/m);
    expect(sharedMacConfig).not.toMatch(/^  hardenedRuntime: false\s*$/m);
    expect(
      ciBuilderConfig,
      'electron-builder-ci.yml must provide the CI-only signing fallback',
    ).not.toBeNull();
    expect(ciBuilderConfig?.trim()).toMatch(
      /^extends: (?:\.\/)?electron-builder\.yml\r?\nmac:\r?\n  identity: '-'\r?\n  hardenedRuntime: false\r?\n  strictVerify: true$/,
    );
  });

  it.each([
    ['mac-x64', 'release/desktop/mac/pii.tools.app'],
    ['mac-arm64', 'release/desktop/mac-arm64/pii.tools.app'],
  ])('%s declares its app path and uses the CI builder config', (label, appPath) => {
    const entry = matrixEntry(releaseWorkflow, label);

    expect(
      {
        commandUsesCiConfig: /^            command: .*--config(?:=|\s+)electron-builder-ci\.yml\s*$/m.test(entry),
        appPathIsExact: entry.includes(`            appPath: ${appPath}`),
      },
      `${label} must select the CI signing config and its actual electron-builder app path`,
    ).toEqual({
      commandUsesCiConfig: true,
      appPathIsExact: true,
    });
  });

  it('runs this signing policy test before the matrix build', () => {
    const buildJob = jobSection(releaseWorkflow, 'build');
    const signingPolicyTest = buildJob.search(
      /^      - run: npm test -- [^\r\n]*\bscripts\/electron-release-signing\.test\.js(?:\s|$)[^\r\n]*$/m,
    );
    const matrixBuild = buildJob.search(/^      - run: \$\{\{ matrix\.command \}\}\s*$/m);

    expect(
      signingPolicyTest,
      'release CI must explicitly invoke the signing policy test',
    ).toBeGreaterThanOrEqual(0);
    expect(
      matrixBuild,
      'the signing policy test must run before the matrix build',
    ).toBeGreaterThan(signingPolicyTest);
  });

  it('strictly verifies the matrix macOS app after building and before upload', () => {
    const buildJob = jobSection(releaseWorkflow, 'build');
    const matrixBuild = buildJob.search(/^      - run: \$\{\{ matrix\.command \}\}\s*$/m);
    const artifactUpload = buildJob.search(/^      - uses: actions\/upload-artifact@v4\s*$/m);

    expect(matrixBuild, 'release build job must run the matrix build command').toBeGreaterThanOrEqual(0);
    expect(artifactUpload, 'release build job must upload its artifacts').toBeGreaterThan(matrixBuild);

    const preUploadSteps = buildJob.slice(matrixBuild, artifactUpload);
    expect(
      preUploadSteps,
      'a macOS-only strict codesign verification must gate artifact upload',
    ).toMatch(
      /^      - (?:name: [^\r\n]+\r?\n        )?if: (?:\$\{\{\s*)?runner\.os\s*==\s*['"]macOS['"](?:\s*\}\})?\r?\n        run: codesign --verify --deep --strict --verbose=4 ['"]?\$\{\{ matrix\.appPath \}\}['"]?\s*$/m,
    );
  });
});
