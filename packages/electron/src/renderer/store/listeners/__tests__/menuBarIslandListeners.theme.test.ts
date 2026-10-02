import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getBaseThemeColors } from '@nimbalyst/runtime/editor/themes/palette';
import crystalDark from '@nimbalyst/runtime/themes/builtin/crystal-dark/theme.json';
import monokai from '@nimbalyst/runtime/themes/builtin/monokai/theme.json';
import solarizedDark from '@nimbalyst/runtime/themes/builtin/solarized-dark/theme.json';
import solarizedLight from '@nimbalyst/runtime/themes/builtin/solarized-light/theme.json';
import { initMenuBarIslandListener } from '../menuBarIslandListeners';

type FileTheme = { id: string; isDark: boolean; colors: Record<string, string> };
const FILE_THEMES = [crystalDark, monokai, solarizedDark, solarizedLight] as FileTheme[];

// Mirrors main's getResolvedThemeSync: crystal-dark stays, other file themes
// collapse to the base theme their isDark flag names.
function resolve(id: string): string {
  if (id === 'light' || id === 'dark' || id === 'crystal-dark') return id;
  const theme = FILE_THEMES.find((t) => t.id === id);
  return theme?.isDark ? 'dark' : 'light';
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// The island does not run useTheme, and NimbalystTheme.css only carries light
// fallbacks on :root, so the listener must write the --nim-* colors itself.
describe('menu bar island theme', () => {
  let themeId = 'dark';
  let themeHandler: (() => void) | null = null;
  let cleanup: () => void = () => {};

  beforeEach(() => {
    themeHandler = null;
    document.documentElement.removeAttribute('style');
    document.documentElement.className = '';
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      getThemeSync: () => themeId,
      getResolvedThemeSync: () => resolve(themeId),
      on: (channel: string, handler: () => void) => {
        if (channel === 'theme-change') themeHandler = handler;
        return () => {};
      },
      invoke: (channel: string, id?: string) => {
        if (channel !== 'theme:get') return Promise.resolve({});
        const theme = FILE_THEMES.find((t) => t.id === id);
        // theme:get only knows themes on disk; extension themes reject.
        return theme ? Promise.resolve(theme) : Promise.reject(new Error(`Theme not found: ${id}`));
      },
    };
  });

  afterEach(() => cleanup());

  it('applies the resolved theme colors at init and on theme-change', () => {
    themeId = 'dark';
    cleanup = initMenuBarIslandListener();
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--nim-bg')).toBe(getBaseThemeColors(true).bg);
    expect(root.classList.contains('dark-theme')).toBe(true);

    themeId = 'light';
    themeHandler!();
    expect(root.style.getPropertyValue('--nim-bg')).toBe(getBaseThemeColors(false).bg);
    expect(root.classList.contains('dark-theme')).toBe(false);
  });

  it.each(FILE_THEMES.map((t) => [t.id, t] as const))(
    'paints the %s theme colors, not only the base palette',
    async (_id, theme) => {
      themeId = theme.id;
      cleanup = initMenuBarIslandListener();
      await flush();
      const root = document.documentElement;
      expect(root.classList.contains(`${resolve(theme.id)}-theme`)).toBe(true);
      expect(root.style.getPropertyValue('--nim-bg')).toBe(theme.colors.bg);
      expect(root.style.getPropertyValue('--nim-primary')).toBe(theme.colors.primary);
      expect(root.style.getPropertyValue('--nim-text')).toBe(theme.colors.text);
    },
  );

  it('follows a runtime switch into and back out of crystal-dark', async () => {
    themeId = 'dark';
    cleanup = initMenuBarIslandListener();
    await flush();
    const root = document.documentElement;

    themeId = 'crystal-dark';
    themeHandler!();
    await flush();
    expect(root.style.getPropertyValue('--nim-bg')).toBe(crystalDark.colors.bg);
    expect(root.classList.contains('crystal-dark-theme')).toBe(true);

    themeId = 'dark';
    themeHandler!();
    await flush();
    expect(root.style.getPropertyValue('--nim-bg')).toBe(getBaseThemeColors(true).bg);
    expect(root.style.getPropertyValue('--nim-primary')).toBe(getBaseThemeColors(true).primary);
    expect(root.classList.contains('crystal-dark-theme')).toBe(false);
  });

  it('keeps the base palette when theme:get cannot load the theme (extension themes)', async () => {
    themeId = 'some-extension.theme';
    cleanup = initMenuBarIslandListener();
    await flush();
    expect(document.documentElement.style.getPropertyValue('--nim-bg')).toBe(
      getBaseThemeColors(false).bg,
    );
  });
});
