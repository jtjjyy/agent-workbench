// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { App } from '../../src/renderer/components/App';

afterEach(cleanup);
test('renders the desktop application heading', () => {
  render(createElement(App));
  expect(screen.getByRole('heading', { name: 'Agent Workbench' })).toBeTruthy();
});
