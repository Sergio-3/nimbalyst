import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as rtl from '@testing-library/react';
import { MarkdownRenderer } from '../MarkdownRenderer';

const { render, screen, fireEvent, waitFor } = rtl;

/** Accessible name of the button in its two states. */
const IDLE = 'Copy code';
const DONE = 'Copied!';

describe('MarkdownRenderer code-block copy button', () => {
  let copied: string[];

  beforeEach(() => {
    copied = [];
    (window as any).electronAPI = {
      copyToClipboard: vi.fn((text: string) => {
        copied.push(text);
        return Promise.resolve();
      }),
    };
  });

  afterEach(() => {
    delete (window as any).electronAPI;
  });

  it.each([
    ['with a language', '```js\nconst a = 1;\nconst b = 2;\n```', 'const a = 1;\nconst b = 2;'],
    ['without a language', '```\nplain one\nplain two\n```', 'plain one\nplain two'],
    ['single-line', '```\nnpm install nimbalyst\n```', 'npm install nimbalyst'],
  ])('copies the source of a fenced block %s, not the rendered markup', async (_label, content, expected) => {
    render(<MarkdownRenderer content={content} />);

    fireEvent.click(screen.getByRole('button', { name: IDLE }));

    await waitFor(() => expect(copied).toEqual([expected]));
  });

  it('shows no confirmation when the clipboard write fails, and does not throw', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as any).electronAPI.copyToClipboard = vi.fn(() => Promise.reject(new Error('clipboard busy')));

    render(<MarkdownRenderer content={'```\nnope\n```'} messageId="m2" />);
    fireEvent.click(screen.getByRole('button', { name: IDLE }));

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: DONE })).toBeNull();
    consoleError.mockRestore();
  });

  it('expires the confirmation, and gives a re-copy a full window instead of the remainder', async () => {
    vi.useFakeTimers();
    try {
      render(<MarkdownRenderer content={'```\nrepeat\nme\n```'} messageId="m6" />);

      fireEvent.click(screen.getByRole('button', { name: IDLE }));
      await rtl.act(async () => {});
      screen.getByRole('button', { name: DONE });

      // Copy again just before the first window closes.
      rtl.act(() => void vi.advanceTimersByTime(1900));
      fireEvent.click(screen.getByRole('button', { name: DONE }));
      await rtl.act(async () => {});

      // An inherited remainder would have run out here.
      rtl.act(() => void vi.advanceTimersByTime(300));
      screen.getByRole('button', { name: DONE });

      rtl.act(() => void vi.advanceTimersByTime(1800));
      expect(screen.queryByRole('button', { name: DONE })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // The currency escape runs over the whole message, code fences included, so
  // `$1` in a shell snippet arrives escaped. Copying that puts a command on the
  // clipboard that no longer runs.
  it('copies shell parameters unescaped, even when the message also contains currency', async () => {
    render(
      <MarkdownRenderer
        content={"it cost $7 and $40M\n\n```sh\nawk '{print $1, $2}'\nsed -i 's/$1/$2/g' file\n```"}
        messageId="m7"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: IDLE }));

    await waitFor(() =>
      expect(copied).toEqual(["awk '{print $1, $2}'\nsed -i 's/$1/$2/g' file"]),
    );
  });

  // Tool results and sub-agent prompts render without a message id, and every
  // streaming chunk re-renders them. A per-mount key would drop the
  // confirmation immediately, which reads as "the click did not work".
  it('keeps the confirmation without a message id, across a re-render', async () => {
    const view = render(<MarkdownRenderer content={'```\ntool\noutput\n```'} />);

    fireEvent.click(screen.getByRole('button', { name: IDLE }));
    await screen.findByRole('button', { name: DONE });

    view.rerender(<MarkdownRenderer content={'```\ntool\noutput\n```'} />);

    screen.getByRole('button', { name: DONE });
  });

  it('leaves inline code without a button', () => {
    const { container } = render(<MarkdownRenderer content={'text with `inline` code'} />);

    expect(container.querySelector('.code-copy-button')).toBeNull();
  });

  it('retires the first confirmation when a second block is copied', async () => {
    render(<MarkdownRenderer content={'```\nfirst\nblock\n```\n\n```\nsecond\nblock\n```'} messageId="m3" />);

    const buttons = screen.getAllByRole('button', { name: IDLE });
    fireEvent.click(buttons[0]);
    await screen.findByRole('button', { name: DONE });

    fireEvent.click(screen.getByRole('button', { name: IDLE }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: DONE })).toHaveLength(1));
    expect(copied).toEqual(['first\nblock', 'second\nblock']);
  });

  // Streaming appends to a block that keeps its identity. The clipboard still
  // holds the shorter, older text, so the confirmation must not survive.
  it('drops the confirmation when the block content grew after the copy', async () => {
    const view = render(<MarkdownRenderer content={'```\nline one\nline two\n```'} messageId="m4" />);

    fireEvent.click(screen.getByRole('button', { name: IDLE }));
    await screen.findByRole('button', { name: DONE });

    view.rerender(<MarkdownRenderer content={'```\nline one\nline two\nline three\n```'} messageId="m4" />);

    expect(screen.queryByRole('button', { name: DONE })).toBeNull();
  });
});
