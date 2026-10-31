import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Footer from '../components/Footer.js';
import { setBrandingTags } from '../test/brandingTags.js';

describe('Footer', () => {
  it('should render the brand name', () => {
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>,
    );
    expect(screen.getByText('Archivum Null')).toBeInTheDocument();
  });

  it('should render the tagline', () => {
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>,
    );
    expect(screen.getByText('Anonymous encrypted file sharing.')).toBeInTheDocument();
  });

  it('should render the configured name and tagline', () => {
    setBrandingTags({ 'application-name': 'Acme Drop', 'brand-tagline': 'Files, sealed' });
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>,
    );
    expect(screen.getByText('Acme Drop')).toBeInTheDocument();
    expect(screen.getByText('Files, sealed.')).toBeInTheDocument();
    expect(screen.queryByText('Archivum Null')).not.toBeInTheDocument();
  });

  it('should not add a full stop to a tagline that ends with punctuation', () => {
    setBrandingTags({ 'brand-tagline': 'Share it safely!' });
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>,
    );
    expect(screen.getByText('Share it safely!')).toBeInTheDocument();
  });

  it('should keep the Source link when the name is changed', () => {
    setBrandingTags({ 'application-name': 'Acme Drop' });
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Source' })).toHaveAttribute(
      'href',
      'https://github.com/whiteravens20/archivum-null',
    );
  });

  it('should render a Source link pointing to GitHub', () => {
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>,
    );
    const link = screen.getByText('Source');
    expect(link).toBeInTheDocument();
    expect(link.closest('a')).toHaveAttribute(
      'href',
      'https://github.com/whiteravens20/archivum-null',
    );
    expect(link.closest('a')).toHaveAttribute('target', '_blank');
    expect(link.closest('a')).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('should render a Terms of Service link', () => {
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>,
    );
    const link = screen.getByText('Terms of Service');
    expect(link).toBeInTheDocument();
    expect(link.closest('a')).toHaveAttribute('href', '/tos');
  });

  it('should leave out the Terms of Service link when the instance has no terms', () => {
    setBrandingTags({ terms: 'none' });
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Terms of Service')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Source' })).toBeInTheDocument();
  });
});
