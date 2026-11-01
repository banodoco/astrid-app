import buildHostedApp from '../../local/global-setup';
import { assertRunBoundary, sourceVersions } from './harness';

export default async function globalSetup(): Promise<void> {
  await assertRunBoundary();
  await sourceVersions('native-codec-chrome155');
  buildHostedApp();
}
