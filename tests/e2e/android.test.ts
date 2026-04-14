import { AppClaw } from '../../src/sdk';
import { describe, it } from 'vitest';
import 'dotenv/config';

describe('SDK E2E — teardown after use', () => {
  it('teardown() after runFlow() does not throw', async () => {
    const app = new AppClaw({
      provider: 'gemini',
      apiKey: process.env.LLM_API_KEY,
      platform: 'android',
      video: true,
    });

    await app.run('open YouTube app');
    await app.run('click on search icon');
    await app.run('wait 1 second');
    await app.run('type Appium 3.0');
    await app.run('wait 2 seconds');
    await app.run('click on the first result from the list');
    await app.run('wait 3 seconds');
    await app.run('scroll down 2 times');
    await app.run('verify if the screen has video uploaded by TestMu AI');
    await app.teardown();
  }, 90000);
});
