import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Footer from '../components/Footer.js';

describe('Footer', () => {
  it('should render the brand name', () => {
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>
    );
    expect(screen.getByText('Archivum Null')).toBeInTheDocument();
  });

  it('should render the tagline', () => {
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>
    );
    expect(screen.getByText('Zero trust file relay.')).toBeInTheDocument();
  });

  it('should render a Source link pointing to GitHub', () => {
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>
    );
    const link = screen.getByText('Source');
    expect(link).toBeInTheDocument();
    expect(link.closest('a')).toHaveAttribute(
      'href',
      'https://github.com/whiteravens20/archivum-null'
    );
    expect(link.closest('a')).toHaveAttribute('target', '_blank');
    expect(link.closest('a')).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('should render a Terms of Service link', () => {
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>
    );
    const link = screen.getByText('Terms of Service');
    expect(link).toBeInTheDocument();
    expect(link.closest('a')).toHaveAttribute('href', '/tos');
  });
});
