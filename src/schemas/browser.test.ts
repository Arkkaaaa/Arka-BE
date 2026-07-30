import assert from 'node:assert/strict';
import test from 'node:test';
import { CreatePreparationRequestSchema, UpdateProfileRequestSchema } from './browser.js';

test('accepts a validated profile update and rejects credentialed image URLs', () => {
  assert.equal(UpdateProfileRequestSchema.safeParse({
    name: 'Adrian',
    image: 'https://images.example.com/profile.jpg',
    institutionName: 'Panti Sejahtera',
  }).success, true);
  assert.equal(UpdateProfileRequestSchema.safeParse({
    name: 'Adrian',
    image: 'data:image/jpeg;base64,QUJDRA==',
    institutionName: 'Panti Sejahtera',
  }).success, true);
  assert.equal(UpdateProfileRequestSchema.safeParse({
    name: 'Adrian',
    image: 'https://user:password@images.example.com/profile.jpg',
    institutionName: 'Panti Sejahtera',
  }).success, false);
});

test('allows name-only participant entry for sequence memory', () => {
  const parsed = CreatePreparationRequestSchema.parse({
    mode: 'SEQUENCE_MEMORY',
    displayName: 'Ibu Sari',
    privacyAcknowledged: true,
  });
  assert.equal(parsed.participantReference, undefined);
});

test('keeps participant reference required for other modes', () => {
  assert.equal(
    CreatePreparationRequestSchema.safeParse({
      mode: 'MOTOR_GRIP',
      displayName: 'Ibu Sari',
      privacyAcknowledged: true,
    }).success,
    false,
  );
});
