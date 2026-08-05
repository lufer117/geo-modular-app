/**
 * utils/logoResolver.js
 *
 * Resuelve la URL de un logo (municipio, entidad territorial — provincia/
 * ccaa, empresa...) probando en cascada las extensiones habituales, sin
 * asumir ninguna de antemano ni mantener una tabla editorial a mano
 * (ver 3DECISIONS.md, decisión B2 — geometría desacoplada de presentación).
 *
 * ── RESPONSABILIDAD ÚNICA ──────────────────────────────────────────────
 * Dado un identificador base (sin extensión) y una carpeta, confirma cuál
 * extensión existe realmente en el servidor probando la carga real de la
 * imagen en el navegador — no un mapeo hardcodeado código→extensión ni una
 * llamada HEAD (que no todo hosting estático garantiza).
 *
 * ── POR QUÉ SE EXTRAJO A UN MÓDULO COMPARTIDO ────────────────────────────
 * Antes vivía duplicado (o directamente ausente): una copia privada en
 * main.js resolvía el logo por-municipio (_resolverLogoMunicipio), pero el
 * logo de entidad territorial (branding.logo_cliente) asumía ruta+extensión
 * hardcodeada dentro de deployment.js — causa raíz del bug de País Vasco
 * (archivo aún no subido, sin ningún fallback ni cascada). Al extraer aquí
 * la lógica, ambos casos consumen el mismo punto de verdad (DRY real, no
 * dos cascadas casi-iguales mantenidas por separado).
 */

const EXTENSIONES_POR_DEFECTO = ["webp", "jpg", "jpeg", "png", "svg"];

/**
 * Prueba si una imagen carga realmente en el navegador (existe en el
 * servidor), sin asumir nada de antemano.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
function _probarImagen(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload  = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

/**
 * Resuelve la URL de un logo probando extensiones en orden, dentro de una
 * carpeta dada. Punto único usado tanto para logo por-municipio como para
 * logo de entidad territorial (provincia/ccaa) — ver main.js.
 *
 * @param {string|null|undefined} clave - identificador base del archivo,
 *   sin extensión (ej. codigo_ine "31201", codigoEntidad "48"). Si es
 *   null/undefined/"" devuelve null de inmediato sin probar red — caso
 *   normal para clientes sin logo propio (demo, o entidades que aún no
 *   subieron su imagen).
 * @param {Object} [opciones]
 * @param {string} [opciones.carpeta="../assets/logos"] - ruta relativa
 *   donde buscar los archivos.
 * @param {string[]} [opciones.extensiones] - orden de prueba. Por defecto
 *   EXTENSIONES_POR_DEFECTO.
 * @returns {Promise<string|null>} URL resuelta, o null si ninguna
 *   extensión existe (caso normal — no todas las entidades tienen logo
 *   subido todavía).
 */
export async function resolverLogo(clave, opciones = {}) {
  if (!clave) return null;

  const {
    carpeta     = "../assets/logos",
    extensiones = EXTENSIONES_POR_DEFECTO
  } = opciones;

  for (const ext of extensiones) {
    const url = `${carpeta}/${clave}.${ext}`;
    if (await _probarImagen(url)) {
      console.info(`[logoResolver] ✓ "${clave}" → ${url}`);
      return url;
    }
  }

  console.info(`[logoResolver] ✗ "${clave}" → sin archivo en ninguna extensión (${extensiones.join(", ")})`);
  return null;
}