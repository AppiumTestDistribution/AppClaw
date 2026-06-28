import { test } from './fixtures.js';
import { tapLogin } from './steps.js';

/**
 * Shows how a test reads (1) device info and (2) data returned by a fixture.
 * Both arrive through the first argument: `device` is a built-in, `apiUser` is
 * the value the `apiUser` fixture passed to `use(...)` — fully typed as ApiUser.
 */
test('has device info and an API-provisioned user', async ({ app, device, apiUser }) => {
  // 1) device info — supplied by the runner, no UDID/port wiring in the test
  console.log(`running on ${device.name} (${device.udid}, ${device.platform})`);

  // 2) fixture data — the user the API created for this test (autocompletes)
  console.log(`provisioned user ${apiUser.email}`);

  // In a real signup test you'd drive the UI with the provisioned creds:
  //   await app.run(`Type ${apiUser.email} into the email field`);
  //   await app.run(`Type ${apiUser.password} into the password field`);
  await tapLogin(app);
  await app.verify('the list is visible');
});
