import { getBranding } from '../branding.ts';

interface LogoProps {
  className: string;
}

/**
 * The mark, in the variant that suits the theme. The built-in dark-theme mark is
 * transparent against a dark page and washes out on a light one, hence two files;
 * an operator can replace either (docs/BRANDING.md).
 *
 * With the `auto` theme the choice is left to the browser through <picture>, so only
 * one of the two files is fetched and no script has to watch the colour scheme.
 * The image is decorative: the name is in the heading next to it.
 */
export default function Logo({ className }: LogoProps) {
  const { theme, logo, logoLight } = getBranding();
  // object-contain: an operator's logo need not be square, and must not be stretched.
  const classes = `${className} object-contain`;

  if (theme === 'light') {
    return <img src={logoLight} alt="" className={classes} />;
  }
  if (theme === 'auto') {
    return (
      <picture className="contents">
        <source srcSet={logoLight} media="(prefers-color-scheme: light)" />
        <img src={logo} alt="" className={classes} />
      </picture>
    );
  }
  return <img src={logo} alt="" className={classes} />;
}
