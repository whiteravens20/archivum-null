import { getBranding } from '../branding.ts';

const DARK_THEME_MARK = '/logo-symbol.webp';
const LIGHT_THEME_MARK = '/logo-symbol-light.webp';

interface LogoProps {
  className: string;
}

/**
 * The mark, in the variant that suits the theme. The dark-theme mark is transparent
 * against a dark page and washes out on a light one, hence the second file.
 *
 * With the `auto` theme the choice is left to the browser through <picture>, so only
 * one of the two files is fetched and no script has to watch the colour scheme.
 * The image is decorative: the name is in the heading next to it.
 */
export default function Logo({ className }: LogoProps) {
  const { theme } = getBranding();

  if (theme === 'light') {
    return <img src={LIGHT_THEME_MARK} alt="" className={className} />;
  }
  if (theme === 'auto') {
    return (
      <picture className="contents">
        <source srcSet={LIGHT_THEME_MARK} media="(prefers-color-scheme: light)" />
        <img src={DARK_THEME_MARK} alt="" className={className} />
      </picture>
    );
  }
  return <img src={DARK_THEME_MARK} alt="" className={className} />;
}
