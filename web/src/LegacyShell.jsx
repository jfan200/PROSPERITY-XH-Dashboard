import { useEffect, useRef } from 'react';

function loadClassicScript(scriptSrc) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-legacy-script="${scriptSrc}"]`);
    if (existing) {
      existing.remove();
    }

    const script = document.createElement('script');
    script.src = scriptSrc;
    script.async = false;
    script.dataset.legacyScript = scriptSrc;
    script.onload = () => resolve(script);
    script.onerror = () => reject(new Error(`Failed to load ${scriptSrc}`));
    document.body.appendChild(script);
  });
}

export default function LegacyShell({ html, scriptSrc }) {
  const shellRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      if (!shellRef.current) return;
      shellRef.current.innerHTML = html;
      await loadClassicScript(scriptSrc);
      if (cancelled) return;
      window.dispatchEvent(new Event('legacy-shell-ready'));
    }

    boot().catch(error => {
      console.error(error);
    });

    return () => {
      cancelled = true;
    };
  }, [html, scriptSrc]);

  return <div ref={shellRef} />;
}
