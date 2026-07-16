// OWNER: fe-shell — may refine values; other agents import tokens, never hardcode colors.
export const colors = {
  primary: '#2E7D32',
  primaryDark: '#1B5E20',
  accent: '#8D6E63',
  bg: '#F6F8F4',
  card: '#FFFFFF',
  text: '#1C2321',
  textMuted: '#5F6B64',
  border: '#DDE4DC',
  danger: '#C62828',
  warning: '#EF6C00',
  info: '#1565C0',
  success: '#2E7D32',
  onPrimary: '#FFFFFF',
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
export const radius = { sm: 6, md: 10, lg: 16 };

export const severityColor: Record<string, string> = {
  info: colors.info,
  warning: colors.warning,
  critical: colors.danger,
};
