/**
 * config/configEngine.js
 *
 * Motor de resolución: dado un municipio, devuelve las capas del catálogo
 * que le corresponden según sus reglas de cobertura geográfica.
 *
 * ── PATRÓN REPOSITORY ────────────────────────────────────────────────────
 * Este módulo define QUÉ necesita (fetchCapas → array filtrado) pero
 * es completamente agnóstico a la fuente de datos. La fuente la
 * proporciona el adaptador inyectado desde main.js.
 *
 * ── VENTAJA ACADÉMICA (argumentar con el tutor) ───────────────────────────
 * Mantenimiento O(1): añadir una capa nueva al catálogo la distribuye
 * automáticamente a todos los municipios que corresponda. No hay que
 * tocar ningún fichero de configuración por municipio, porque no existe
 * tal fichero. Las reglas de cobertura del catálogo lo gestionan todo.
 *
 * ── REGLAS DE COBERTURA ──────────────────────────────────────────────────
 *   "nacional"   → siempre incluir (aplica a toda España)
 *   "europeo"    → siempre incluir (cobertura supranacional)
 *   "global"     → siempre incluir (cobertura mundial)
 *   "autonomica" → incluir si capa.cobertura.ccaa_code === municipio.ccaa_code
 *   "provincial" → incluir si capa.cobertura.provincia_code === municipio.provincia_code
 *   "municipal"  → incluir si municipio.codigo_ine ∈ capa.cobertura.codigos_ine[]
 *   "espacial"   → reservado para PostGISAdapter (futuro). Excluido con aviso.
 */

let _adaptador = null;

// ─── API pública ──────────────────────────────────────────────────────────

/**
 * Registra el adaptador de datos.
 * Llamar exactamente UNA VEZ en main.js antes de cualquier fetchCapas().
 *
 * @param {Object} adaptador - Debe implementar: getCatalogo() → Promise<Capa[]>
 */
export function setAdaptador(adaptador) {
  if (typeof adaptador?.getCatalogo !== "function") {
    throw new Error(
      "[configEngine] El adaptador debe implementar getCatalogo(): Promise<Capa[]>"
    );
  }
  _adaptador = adaptador;
  console.info(
    "[configEngine] Adaptador registrado:",
    adaptador.constructor?.name ?? "adaptador anónimo"
  );
}

/**
 * Devuelve las capas del catálogo que aplican al municipio dado.
 * Filtra por reglas de cobertura y ordena por prioridad (P0 → P1 → P2...).
 *
 * @param {Object} municipioData - Objeto de config/municipios.js
 *   { codigo_ine, nombre, provincia_code, ccaa_code, bbox, polygon }
 * @returns {Promise<Capa[]>} Array filtrado y ordenado
 */
export async function fetchCapas(municipioData) {
  if (!_adaptador) {
    throw new Error(
      "[configEngine] No hay adaptador registrado. Llama a setAdaptador() en main.js primero."
    );
  }

  const catalogo = await _adaptador.getCatalogo();

  const capas = catalogo.filter(capa => _aplicaAlMunicipio(capa, municipioData));

  // Ordenar por prioridad para que el árbol de capas tenga un orden coherente
  const ORDEN_PRIORIDAD = { P0: 0, P1: 1, P2: 2, P3: 3, DESC: 99 };
  capas.sort(
    (a, b) => (ORDEN_PRIORIDAD[a.prioridad] ?? 99) - (ORDEN_PRIORIDAD[b.prioridad] ?? 99)
  );

  console.info(
    `[configEngine] "${municipioData.nombre}": ` +
    `${capas.length} de ${catalogo.length} capas resueltas`
  );

  return capas;
}

// ─── Lógica privada de resolución ─────────────────────────────────────────

/**
 * Determina si una capa del catálogo aplica a un municipio concreto.
 * Función pura, sin estado, testeable de forma aislada.
 *
 * @param {Object} capa       - Entrada del catalogo-capas.json
 * @param {Object} municipio  - Objeto de config/municipios.js
 * @returns {boolean}
 */
function _aplicaAlMunicipio(capa, municipio) {
  const cobertura = capa.cobertura;

  if (!cobertura?.tipo) {
    console.warn(`[configEngine] Capa "${capa.id}" sin campo cobertura.tipo — ignorada`);
    return false;
  }

  switch (cobertura.tipo) {
    case "nacional":
    case "europeo":
    case "global":
      return true;

    case "autonomica":
      return cobertura.ccaa_code === municipio.ccaa_code;

    case "provincial":
      return cobertura.provincia_code === municipio.provincia_code;

    case "municipal":
      return Array.isArray(cobertura.codigos_ine) &&
             cobertura.codigos_ine.includes(municipio.codigo_ine);

    case "espacial":
      // Requiere consulta espacial real con bbox — reservado para PostGISAdapter.
      // LocalJsonAdapter no puede resolver esto correctamente sin backend.
      console.warn(
        `[configEngine] Capa "${capa.id}" tiene cobertura "espacial". ` +
        `Ignorada hasta que PostGISAdapter esté disponible.`
      );
      return false;

    default:
      console.warn(
        `[configEngine] Tipo de cobertura desconocido "${cobertura.tipo}" ` +
        `en capa "${capa.id}" — ignorada`
      );
      return false;
  }
}