/**
 * config/configEngine.js
 *
 * Motor de resolución: dado un municipio (o un territorio completo),
 * devuelve las capas del catálogo que le corresponden según sus reglas
 * de cobertura geográfica.
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
 * ── AJUSTE (migración LocalJsonAdapter genérico) ──────────────────────────
 * El adaptador ya no expone getCatalogo() sino getData() — nombre genérico,
 * porque la misma clase LocalJsonAdapter ahora también se usa para leer
 * municipios/provincias/ccaa desde territorioResolver.js, no solo capas.
 * Ver config/adapters/LocalJsonAdapter.js para el detalle de esa migración.
 * El contrato de este módulo sigue siendo el mismo: cualquier adaptador
 * inyectado debe exponer getData() → Promise<Capa[]>.
 *
 * ── REGLAS DE COBERTURA ──────────────────────────────────────────────────
 *   "nacional"   → siempre incluir (aplica a toda España)
 *   "europeo"    → siempre incluir (cobertura supranacional)
 *   "global"     → siempre incluir (cobertura mundial)
 *   "autonomica" → incluir si capa.cobertura.ccaa_code === territorio.ccaa_code
 *   "provincial" → incluir si capa.cobertura.provincia_code === territorio.provincia_code
 *   "municipal"  → incluir si territorio.codigo_ine ∈ capa.cobertura.codigos_ine[]
 *   "espacial"   → reservado para PostGISAdapter (futuro). Excluido con aviso.
 *
 * ── AJUSTE (soporte de ámbito territorial provincia/ccaa) ──────────────────
 * fetchCapas() resuelve el paquete completo para un municipio concreto —
 * sigue siendo el camino usado por el caso "municipio" (ayuntamiento único
 * o comarca curada), sin cambios de comportamiento.
 * Se añaden dos funciones que reutilizan _aplicaAlMunicipio sin duplicar
 * sus reglas, particionando el mismo universo de capas:
 *   fetchCapasTerritoriales() → todo excepto cobertura "municipal".
 *     Usada al arrancar en ámbito provincia/ccaa, antes de elegir municipio.
 *   fetchCapasMunicipales()   → únicamente cobertura "municipal".
 *     Usada para SUMAR capas al elegir un municipio dentro del territorio,
 *     sin reconstruir la base territorial ya cargada (ver
 *     municipioSelector.agregarCapasMunicipio()).
 * fetchCapasTerritoriales(territorio) ∪ fetchCapasMunicipales(municipio)
 * es exactamente el mismo conjunto que fetchCapas(municipio) devolvería
 * hoy — se particiona el mismo resultado, no se inventan reglas nuevas.
 */

let _adaptador = null;

// ─── API pública ──────────────────────────────────────────────────────────

/**
 * Registra el adaptador de datos.
 * Llamar exactamente UNA VEZ en main.js antes de cualquier fetchCapas().
 *
 * @param {Object} adaptador - Debe implementar: getData() → Promise<Capa[]>
 */
export function setAdaptador(adaptador) { 
  if (typeof adaptador?.getData !== "function") { //comprueba que existe adaptador y que sabe obtener datos
    throw new Error(
      "[configEngine] El adaptador debe implementar getData(): Promise<Capa[]>"
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
 * @param {Object} municipioData - Un municipio individual ya resuelto
 *   (un elemento de municipiosDisponibles[], ver territorioResolver.js).
 *   Forma esperada: { codigo_ine, nombre, provincia_code, ccaa_code, bbox, polygon }
 * @returns {Promise<Capa[]>} Array filtrado y ordenado
 */
export async function fetchCapas(municipioData) {
  if (!_adaptador) { //comprueba adaptador
    throw new Error(
      "[configEngine] No hay adaptador registrado. Llama a setAdaptador() en main.js primero."
    );
  }

  const catalogo = await _adaptador.getData();

  const capas = catalogo.filter(capa => _aplicaAlMunicipio(capa, municipioData)); //recorre todas las capas, si devuelve true la capa entra

  // Ordenar por prioridad para que el árbol de capas tenga un orden coherente
  const ORDEN_PRIORIDAD = { P0: 0, P1: 1, P2: 2, P3: 3, DESC: 99 }; // prioridad de mpv
  capas.sort(
    (a, b) => (ORDEN_PRIORIDAD[a.prioridad] ?? 99) - (ORDEN_PRIORIDAD[b.prioridad] ?? 99)
  );

  console.info(
    `[configEngine] "${municipioData.nombre}": ` +
    `${capas.length} de ${catalogo.length} capas resueltas`
  );

  return capas;
}

/**
 * Devuelve las capas del catálogo con cobertura territorial (nacional,
 * europea, global, autonómica, provincial) — EXCLUYE cobertura "municipal".
 *
 * ── POR QUÉ EXISTE (aparte de fetchCapas) ─────────────────────────────────
 * A nivel territorio (provincia/ccaa) no hay codigo_ine todavía — el usuario
 * aún no eligió municipio — pero sí queremos pintar ya las capas que
 * corresponden a ese territorio. Esta función resuelve exactamente eso:
 * el subconjunto de _aplicaAlMunicipio que NO depende de codigo_ine.
 *
 * @param {Object} territorioData - { provincia_code, ccaa_code, codigo_ine: null, bbox, polygon }
 * @returns {Promise<Capa[]>} Array filtrado y ordenado
 */
export async function fetchCapasTerritoriales(territorioData) {
  if (!_adaptador) {
    throw new Error(
      "[configEngine] No hay adaptador registrado. Llama a setAdaptador() en main.js primero."
    );
  }

  const catalogo = await _adaptador.getData();

  const capas = catalogo.filter(capa =>
    capa.cobertura?.tipo !== "municipal" &&
    _aplicaAlMunicipio(capa, territorioData)
  );

  const ORDEN_PRIORIDAD = { P0: 0, P1: 1, P2: 2, P3: 3, DESC: 99 };
  capas.sort(
    (a, b) => (ORDEN_PRIORIDAD[a.prioridad] ?? 99) - (ORDEN_PRIORIDAD[b.prioridad] ?? 99)
  );

  console.info(
    `[configEngine] Ámbito territorial: ${capas.length} de ${catalogo.length} capas resueltas`
  );

  return capas;
}

/**
 * Devuelve ÚNICAMENTE las capas de cobertura "municipal" que aplican a un
 * municipio concreto. Complemento de fetchCapasTerritoriales(): juntas
 * cubren exactamente el mismo universo que fetchCapas(), pero por separado
 * permiten el modelo de carga incremental (base territorial + añadido
 * municipal) sin reconstruir ni duplicar peticiones al catálogo.
 *
 * @param {Object} municipioData - Municipio concreto, con codigo_ine
 * @returns {Promise<Capa[]>} Array filtrado y ordenado
 */
export async function fetchCapasMunicipales(municipioData) {
  if (!_adaptador) {
    throw new Error(
      "[configEngine] No hay adaptador registrado. Llama a setAdaptador() en main.js primero."
    );
  }

  const catalogo = await _adaptador.getData();

  const capas = catalogo.filter(capa =>
    capa.cobertura?.tipo === "municipal" &&
    _aplicaAlMunicipio(capa, municipioData)
  );

  const ORDEN_PRIORIDAD = { P0: 0, P1: 1, P2: 2, P3: 3, DESC: 99 };
  capas.sort(
    (a, b) => (ORDEN_PRIORIDAD[a.prioridad] ?? 99) - (ORDEN_PRIORIDAD[b.prioridad] ?? 99)
  );

  console.info(
    `[configEngine] "${municipioData.nombre}": ${capas.length} capas municipales adicionales`
  );

  return capas;
}

// ─── Lógica privada de resolución ─────────────────────────────────────────

/**
 * Determina si una capa del catálogo aplica a un municipio o territorio
 * concreto. Función pura, sin estado, testeable de forma aislada.
 * Compartida por fetchCapas, fetchCapasTerritoriales y fetchCapasMunicipales
 * — las tres reutilizan exactamente las mismas reglas de cobertura, solo
 * cambia qué subconjunto de capas se les pasa antes de evaluar.
 *
 * @param {Object} capa       - Entrada del catalogo-capas.json
 * @param {Object} municipio  - Municipio o territorio individual, misma
 *   forma que municipioData/territorioData en las funciones públicas
 * @returns {boolean}
 */
function _aplicaAlMunicipio(capa, municipio) { //solo recibe si es true o false
  const cobertura = capa.cobertura; //obtiene cobertura de la capa según el catalogo

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