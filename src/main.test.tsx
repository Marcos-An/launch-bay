import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('renderer entry', () => {
  it('can render the app without crashing', () => {
    const { container } = render(<App />);
    expect(container).toBeTruthy();
  });
});
