/**
 * core/layerInitializer.js
 *
 * Aplica comportamiento runtime a capas ya creadas por layerFactory.
 *
 * ── RESPONSABILIDAD ──────────────────────────────────────────────────────
 * Dado el campo "disponibilidad_municipal" del catálogo y los datos del
 * municipio activo, configura cada capa para mostrar solo los datos
 * del municipio seleccionado.
 *
 * ── ESTRATEGIAS DE FILTRADO ──────────────────────────────────────────────
 *
 * BBOX — WMS:
 *   El recorte visual lo gestiona la máscara de mapManager.
 *   Aquí no se hace nada adicional sobre la capa WMS; el servidor
 *   responde con datos para el viewport visible y la máscara recorta
 *   visualmente el exterior del municipio.
 *   Para FeatureLayer/WFS con BBOX: se aplica featureEffect DECLARATIVO
 *   (sin layer.load()) para limitar las entidades al bbox del municipio.
 *   El filtro se asigna antes de que la capa entre al mapa; el SDK lo
 *   aplica en el momento de la carga, no antes.
 *   Para GeoJSON con BBOX: la carga completa es inevitable en cliente
 *   sin backend; la máscara gestiona el recorte visual.
 *
 * FILTRABLE — WMS con soporte CQL_FILTER (GeoServer):
 *   Se añaden customLayerParameters con CQL_FILTER al WMSLayer.
 *   El servidor retorna solo la geometría del municipio → eficiente en
 *   ancho de banda y además la máscara visual es redundante (pero actúa
 *   como seguridad adicional).
 *   Para FeatureLayer FILTRABLE: definitionExpression con el campo de filtro.
 *   NOTA: FILTRABLE sí usa layer.load() porque definitionExpression requiere
 *   conocer el esquema del servicio antes de aplicarse.
 *
 * DIRECTA:
 *   La URL o el servicio ya incorpora el ámbito municipal. Sin filtro extra.
 *
 * CONSULTA:
 *   La capa se usa solo para GetFeatureInfo / identify. Se carga sin filtro.
 */

// ─── API pública ──────────────────────────────────────────────────────────

/**
 * Inicializa una capa aplicando los filtros correspondientes al municipio.
 *
 * @param {Layer}  layer         - Instancia Esri creada por layerFactory
 * @param {Object} config        - Configuración de la capa en el catálogo
 * @param {Object} municipioData - Datos del municipio activo (de municipios.js)
 * @returns {Promise<void>}
 */
export async function inicializarCapa(layer, config, municipioData) {
  if (!layer || !config || !municipioData) return;

  try {
    switch (config.disponibilidad_municipal) {

      case "BBOX":
        await _estrategiaBbox(layer, config, municipioData);
        break;

      case "FILTRABLE":
        // TODO: pendiente de añadir campo_filtro al catálogo antes de activar.
        // La lógica está implementada en _estrategiaFiltrable().
        await _estrategiaFiltrable(layer, config, municipioData);
        break;

      case "DIRECTA":
        console.info(`[layerInitializer] "${config.id}" DIRECTA — sin filtro extra`);
        break;

      case "CONSULTA":
        console.info(`[layerInitializer] "${config.id}" CONSULTA — visible, sin filtro espacial`);
        break;

      default:
        console.warn(
          `[layerInitializer] disponibilidad_municipal desconocida: ` +
          `"${config.disponibilidad_municipal}" en "${config.id}"`
        );
    }
  } catch (err) {
    console.error(`[layerInitializer] Error al inicializar capa "${config.id}":`, err);
  }
}

/**
 * Recarga una capa (útil al cambiar de municipio sin recrear la instancia).
 * Solo aplica a tipos que implementan refresh() (WMSLayer, FeatureLayer...).
 * @param {Layer} layer
 */
export function recargarCapa(layer) {
  if (typeof layer?.refresh === "function") {
    layer.refresh();
    console.info(`[layerInitializer] Capa "${layer.id}" recargada`);
  }
}

/**
 * Tipos de capa con soporte de inicialización implementado.
 * @returns {string[]}
 */
export function getTiposImplementados() {
  return ["WMS", "WFS", "FEATURE", "GEOJSON"];
}

// ─── Estrategias privadas ─────────────────────────────────────────────────

/**
 * Estrategia BBOX:
 *   - WMS: recorte visual delegado a la máscara de mapManager.
 *   - WFS: customParameters.BBOX → filtro SERVIDOR real (OGC estándar).
 *       El servicio devuelve solo features del bbox desde el primer request.
 *   - FEATURE (ArcGIS REST): featureEffect declarativo (filtro cliente).
 *       El servidor no acepta parámetros OGC; filtro servidor real
 *       requiere definitionExpression → estrategia FILTRABLE.
 *   - GeoJSON: carga completa inevitable en cliente sin backend.
 */
async function _estrategiaBbox(layer, config, municipioData) {
  const [xmin, ymin, xmax, ymax] = municipioData.bbox;
  const tipo = config.tipo;

  if (tipo === "WMS") {
    // WMS: la máscara visual lo cubre. El servidor WMS sirve los tiles del
    // viewport, que tras el zoom al municipio solo incluye datos del área.
    // Sin acción adicional en la capa.
    console.info(
      `[layerInitializer] WMS BBOX "${config.id}" → recorte visual delegado a máscara municipal`
    );

  } else if (tipo === "WFS") {
    // customParameters.BBOX → filtro SERVIDOR real.
    // El servicio WFS recibe el bbox en cada GetFeature request
    // y devuelve solo las features que intersectan esa área.
    // Es radicalmente más eficiente que featureEffect:
    //   featureEffect → descarga todo, oculta visualmente lo que sobra
    //   customParameters.BBOX → el servidor ya no envía lo que sobra
    // Formato OGC estándar: "xmin,ymin,xmax,ymax,CRS"
    layer.customParameters = {
      BBOX: `${xmin},${ymin},${xmax},${ymax},EPSG:4326`
    };
    console.info(
      `[layerInitializer] WFS BBOX servidor "${config.id}" → [${xmin},${ymin},${xmax},${ymax}]`
    );

  } else if (tipo === "FEATURE") {
    // FeatureLayer con BBOX: featureEffect declarativo (cliente).
    // FeatureLayer ArcGIS REST no acepta customParameters OGC;
    // el filtro servidor real requiere definitionExpression con geometría,
    // que a su vez requiere layer.load() previo → estrategia FILTRABLE.
    // featureEffect es el mejor filtro disponible sin load() para este tipo.
    try {
      const [Extent, FeatureFilter] = await Promise.all([
        $arcgis.import("esri/geometry/Extent"),
        $arcgis.import("esri/layers/support/FeatureFilter")
      ]);
      const extent = new Extent({ xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } });
      layer.featureEffect = {
        filter:         new FeatureFilter({ geometry: extent, spatialRelationship: "intersects" }),
        excludedEffect: "opacity(0)",
        includedEffect: ""
      };
      console.info(`[layerInitializer] FEATURE BBOX declarado en "${config.id}"`);
    } catch (err) {
      console.warn(`[layerInitializer] No se pudo aplicar featureEffect a "${config.id}":`, err);
    }
  } else if (tipo === "GEOJSON") {
    // GeoJSON: en cliente sin backend no es posible filtrar la descarga.
    // La carga es completa; la máscara gestiona el recorte visual.
    console.info(
      `[layerInitializer] GeoJSON BBOX "${config.id}" → carga completa, recorte visual vía máscara`
    );
  }
}

/**
 * Estrategia FILTRABLE:
 *   - WMS con soporte CQL_FILTER (GeoServer): pasar filtro por municipio.
 *     El servidor devuelve solo la geometría del municipio → eficiente.
 *   - FeatureLayer/WFS: definitionExpression con el campo_filtro del catálogo.
 *     El SDK solo descarga las entidades que cumplan la expresión.
 *     NOTA: aquí sí se usa layer.load() porque definitionExpression en
 *     FeatureLayer requiere que el servicio esté cargado para validar
 *     el esquema de campos antes de aplicar el filtro.
 */
async function _estrategiaFiltrable(layer, config, municipioData) {
  const campoFiltro = config.campo_filtro;

  if (!campoFiltro) {
    console.warn(
      `[layerInitializer] Capa "${config.id}" es FILTRABLE pero no tiene campo_filtro en el catálogo`
    );
    return;
  }

  const tipo = config.tipo;

  if (tipo === "WMS") {
    // WMS con CQL_FILTER (servidores GeoServer/GeoServer-compatible).
    // Se aplica como customLayerParameters que WMSLayer incluye en cada tile request.
    // No requiere layer.load(): es un parámetro HTTP añadido a la URL del tile.
    layer.customLayerParameters = {
      CQL_FILTER: `${campoFiltro}='${municipioData.codigo_ine}'`
    };
    console.info(
      `[layerInitializer] WMS CQL_FILTER "${campoFiltro}='${municipioData.codigo_ine}'" → "${config.id}"`
    );

  } else if (tipo === "FEATURE" || tipo === "WFS") {
    // FeatureLayer/WFS: definitionExpression filtra en el servidor.
    // layer.load() necesario aquí para validar que el campo existe en el esquema.
    // Solo aplica a servicios con campo de filtro municipal conocido (catálogo).
    try {
      await layer.load();
      layer.definitionExpression = `${campoFiltro} = '${municipioData.codigo_ine}'`;
      console.info(
        `[layerInitializer] definitionExpression "${layer.definitionExpression}" → "${config.id}"`
      );
    } catch (err) {
      console.warn(
        `[layerInitializer] No se pudo aplicar definitionExpression a "${config.id}":`, err
      );
    }
  }
}