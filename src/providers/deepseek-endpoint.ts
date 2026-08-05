export const DEEPSEEK_STANDARD_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_BETA_BASE_URL = 'https://api.deepseek.com/beta';

export function isOfficialDeepSeekBetaUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.toLocaleLowerCase() === 'api.deepseek.com'
      && url.port === ''
      && url.pathname.replace(/\/+$/u, '').toLocaleLowerCase() === '/beta'
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}
