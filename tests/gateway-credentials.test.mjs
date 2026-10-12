import test from 'node:test';
import assert from 'node:assert/strict';
import { makeKV } from './kv-fake.mjs';
import { loadGatewayConfig, saveGatewayConfig, resolveProvider } from '../functions/api/_gateway-config.js';

// PHASE 9 (zip 119): payment credentials are the tenant's own — never the platform's environment keys, never mixed.
const ENV_KEYS = { PAYWAVE_API_KEY: 'pw_platform', MPESA_CONSUMER_KEY: 'ck_platform', MPESA_CONSUMER_SECRET: 'cs_platform', MPESA_SHORTCODE: '999999', MPESA_PASSKEY: 'pk_platform', PAYWAVE_API_KEY: 'pw_platform', PAYWAVE_EMAIL: 'owner@platform', MPESA_ENV: 'production' };

test('a shop that saved no keys has NO payment gateway — the platform keys in the environment are not used', async () => {
  const env = { mydukapos_kv: makeKV(), ...ENV_KEYS };
  const cfg = await loadGatewayConfig(env, 'C1');
  assert.equal(resolveProvider(cfg), null);
  for (const k of ['paywaveApiKey', 'mpesaConsumerKey', 'mpesaShortcode', 'paywaveApiKey', 'paywaveEmail']) assert.equal(cfg[k], '', k);
  assert.equal(cfg.mpesaEnv, 'production', 'non-secret defaults still apply');
});

test('a shop\'s own keys are used as a complete set — never mixed with environment values', async () => {
  const env = { mydukapos_kv: makeKV(), ...ENV_KEYS };
  await saveGatewayConfig(env, 'C1', { mpesaShortcode: '123456' });            // saved only ONE Daraja field
  const cfg = await loadGatewayConfig(env, 'C1');
  assert.equal(cfg.mpesaShortcode, '123456');
  assert.equal(cfg.mpesaConsumerKey, '', 'no platform secret filled in next to it');
  assert.equal(resolveProvider(cfg), null, 'an incomplete set is not a working gateway');
  await saveGatewayConfig(env, 'C1', { mpesaConsumerKey: 'ck1', mpesaConsumerSecret: 'cs1', mpesaPasskey: 'pk1' });
  assert.equal(resolveProvider(await loadGatewayConfig(env, 'C1')), 'daraja');
  assert.equal(resolveProvider(await loadGatewayConfig(env, 'C2')), null, 'and another shop gets none of it');
});

test('the environment set is used only for a shop the owner explicitly lists (and only when it saved nothing itself)', async () => {
  const env = { mydukapos_kv: makeKV(), ...ENV_KEYS, GATEWAY_ENV_FALLBACK_CLIENTS: 'OWNSHOP, OTHER' };
  const own = await loadGatewayConfig(env, 'OWNSHOP');
  assert.equal(own.paywaveApiKey, 'pw_platform');
  assert.equal((await loadGatewayConfig(env, 'C1')).paywaveApiKey, '');
  await saveGatewayConfig(env, 'OWNSHOP', { paywaveApiKey: 'sk_own' });
  assert.equal((await loadGatewayConfig(env, 'OWNSHOP')).paywaveApiKey, 'sk_own', 'its own key wins');
});
