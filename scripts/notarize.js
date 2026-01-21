const { notarize } = require('@electron/notarize');
require('dotenv').config();

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  
  // Only notarize on macOS
  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    throw new Error('Missing notarization env vars: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID must be set');
  }

  // Explicitly use appId from package.json build config
  const appBundleId = context.packager.config.appId;

  console.log(`Notarizing ${appPath}...`);

  await notarize({
    appBundleId,
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log(`✓ Notarization complete`);
};
