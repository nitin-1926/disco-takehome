import { expect, test } from 'vitest';
import publishers from '@/data/publishers.json';
import personas from '@/data/shopper_personas.json';

test('catalog loads', () => {
  expect(publishers).toHaveLength(20);
  expect(personas).toHaveLength(10);
});
