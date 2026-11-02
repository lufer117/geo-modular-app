/**
 * config/normalizarDeployment.js
 *
 * Única responsabilidad: devolver una copia de DEPLOYMENT con los valores
 * por defecto que falten, en un solo sitio.
 *
 * ── POR QUÉ DEVUELVE UNA COPIA Y NO MUTA ────────────────────────────────
 * Ningún módulo importa deployment.js directamente (solo bootstrap.js):
 * todos reciben el objeto por parámetro. Por eso basta con entregar la copia
 * normalizada y dejar el original intacto, sin efectos laterales.
 *
 * La copia es superficial: `herramientas` y `branding` se comparten con el
 * original. Se congela el primer nivel para que una escritura accidental en
 * runtime lance TypeError (los módulos ES van en modo estricto) en vez de
 * alterar la configuración en silencio.
 *
 * ── ALCANCE ─────────────────────────────────────────────────────────────
 * Solo defaults. Validar valores incorrectos es la pieza 2 de M-01: aquí un
 * `idiomas` mal formado NO se corrige, para no ocultar un error de
 * configuración. Los demás opcionales (herramientas, branding) ya los
 * resuelven sus consumidores con `??` y no se duplican aquí.
 */
export function normalizarDeployment(deployment) {
  const normalizado = { ...deployment };
  const aplicados = [];

  if (normalizado.idiomas == null) {
    normalizado.idiomas = ["es"];
    aplicados.push('idiomas = ["es"]');
  }

  // Misma regla que documenta deploymentTemplate.js: si no se fija
  // idioma_defecto, manda el primer idioma del array.
  if (normalizado.idioma_defecto == null && Array.isArray(normalizado.idiomas)) {
    normalizado.idioma_defecto = normalizado.idiomas[0];
    aplicados.push(`idioma_defecto = "${normalizado.idioma_defecto}"`);
  }

  // Aviso para quien despliega: un default aplicado es una omisión suya.
  if (aplicados.length > 0) {
    console.warn(
      `[normalizarDeployment] Valores por defecto aplicados: ${aplicados.join("; ")}. ` +
      `Defínelos en config/deployment.js para que la configuración sea explícita.`
    );
  }

  return Object.freeze(normalizado);
}