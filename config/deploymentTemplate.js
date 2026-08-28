/**
 * config/deploymentTemplate.js
 *
 * Plantilla de referencia para config/deployment.js
 *
 * ── INSTRUCCIONES ────────────────────────────────────────────────────────
 * 1. Copia este archivo como config/deployment.js
 * 2. Deja UN SOLO bloque `export const DEPLOYMENT = {...}` descomentado
 *    (el que corresponda al cliente). Comenta o borra el resto.
 * 3. Nunca subas deployment.js a git (está en .gitignore).
 *
 * Este archivo NO lee ?cliente= de la URL. Eso es exclusivo del arnés
 * de pruebas multi-cliente usado en desarrollo/demo del TFM. En
 * producción cada cliente recibe su propio deployment.js con un único
 * DEPLOYMENT ya resuelto en build time.
 *
 * ── CAMPOS COMUNES ───────────────────────────────────────────────────────
 *
 *   mode
 *     "demo"       → sin restricción de municipios (TFM / reuniones)
 *     "production" → instancia real para un cliente concreto
 *
 *   cliente
 *     Identificador libre. Solo trazabilidad interna, no afecta comportamiento.
 *
 *   nombre_visible
 *     Nombre del cliente en la UI (cabecera, accesibilidad).
 *
 *   idiomas / idioma_defecto
 *     Idiomas disponibles según el territorio del cliente. El primero del
 *     array marca el idioma de arranque si no se fija idioma_defecto aparte.
 *     Ejemplos: País Vasco → ["eu","es","en"]; Galicia → ["gl","es","en"].
 *
 *   branding.logo_cliente / branding.logo_empresa
 *     Rutas relativas desde app/ o URL absoluta. logo_cliente: null → icono
 *     SVG por defecto (icon="map-pin"). logo_empresa siempre visible.
 *
 * ── MODELOS DE ÁMBITO TERRITORIAL (mutuamente excluyentes) ────────────────
 *
 *   MODELO A — `municipios: [...]`
 *     Lista curada de codigos_ine. Correcto cuando el cliente ES el
 *     municipio (ayuntamiento único) o gestiona un puñado fijo y estable
 *     de municipios sin ámbito administrativo superior que resolver.
 *       []            → sin restricción (demo: todos los del catálogo)
 *       ["X"]         → un municipio: carga automática al arrancar
 *       ["X","Y",...] → varios: selector activo restringido a esa lista
 *
 *   MODELO B — `ambitoTerritorial` + `codigoEntidad`
 *     Para clientes cuyo ámbito ES una entidad administrativa completa
 *     (diputación/provincia, gobierno autonómico/CCAA), no una selección
 *     manual. Activa config/territorioResolver.js: máscara inicial sobre
 *     el territorio COMPLETO al arrancar y buscador con todos sus
 *     municipios, sin editar deployment.js cada vez que el cliente suma
 *     un municipio a su ámbito.
 *       ambitoTerritorial: "provincia" | "ccaa"
 *       codigoEntidad:     código INE de la provincia o CCAA
 *     Ausencia de ambitoTerritorial = caso "municipio" por defecto
 *     (retrocompatible con Modelo A).
 *
 *   No combinar A y B en el mismo deployment.
 *
 * ── CAMPO `herramientas[]` ──────────────────────────────────────────────
 *   Tres estados válidos, cada uno con significado distinto:
 *     1. Array con contenido  → panel con acciones habilitadas/deshabilitadas
 *     2. Array vacío []       → decisión de producto: panel presente, sin
 *                                acciones (el cliente conoce el catálogo y
 *                                elige no exponer ninguna herramienta)
 *     3. Campo ausente        → caso legado / deployment sin migrar.
 *                                initToolPanel() resuelve con
 *                                `DEPLOYMENT.herramientas ?? []` de forma
 *                                seguridad, sin lanzar excepción.
 *   Un `componente`/`componentes` es el nombre del Web Component de
 *   ArcGIS o Calcite que implementa la herramienta. `habilitada: false`
 *   deja la herramienta visible pero inactiva (útil para placeholders sin
 *   backend, como imprimir sin printServiceUrl).
 * ─────────────────────────────────────────────────────────────────────────
 */


// ── CASO MÁS COMPLETO: ámbito CCAA + set completo de herramientas ────────
// Activo por defecto en esta plantilla. Cliente tipo gobierno autonómico:
// cubre TODO el territorio (Modelo B), expone análisis, dibujo e impresión
// (placeholder deshabilitado por falta de backend).

export const DEPLOYMENT = {
  mode:           "production",
  cliente:        "gobierno-autonomico",
  nombre_visible: "Nombre del Gobierno / Comunidad Autónoma",
  ambitoTerritorial: "ccaa",
  codigoEntidad:     "00", // código INE de la CCAA
  idiomas:        ["es", "en"], // añadir lengua cooficial si aplica, primero en el array
  idioma_defecto: "es",
  branding: {
    logo_cliente:  null,
    logo_empresa:  "../assets/logos/empresa.png",
  },
  herramientas: [
    {
      id:         "distancia",
      componentes: {
        "2D": "arcgis-distance-measurement-2d",
        "3D": "arcgis-direct-line-measurement-3d"
      },
      icono:      "measure-line",
      categoria:  "analisis",
      habilitada: true
    },
    {
      id:         "area",
      componentes: {
        "2D": "arcgis-area-measurement-2d",
        "3D": "arcgis-area-measurement-3d"
      },
      icono:      "measure-area",
      categoria:  "analisis",
      habilitada: true
    },
    {
      id:         "dibujo",
      componente: "arcgis-sketch",
      icono:      "pencil",
      categoria:  "analisis",
      habilitada: true,
      sketchOpciones: {
        availableCreateTools: ["point", "polyline", "polygon", "rectangle", "circle"],
        layout: "horizontal"
      }
    },
    {
      id:         "imprimir",
      componente: "arcgis-print",
      icono:      "print",
      categoria:  "exportar",
      habilitada: false, // placeholder: requiere printServiceUrl (backend propio)
    },
    {
      id:         "limpiar",
      componente: null,
      icono:      "trash",
      categoria:  "accion",
      habilitada: true
    }
  ]
};


// ── VARIANTE — ámbito PROVINCIA (diputación) ──────────────────────────────
// Modelo B con ambitoTerritorial "provincia". Mismo patrón que CCAA, cambia
// el nivel administrativo y el codigoEntidad (código INE de provincia).

/*
export const DEPLOYMENT = {
  mode:           "production",
  cliente:        "diputacion-provincia",
  nombre_visible: "Diputación / Nombre de la Provincia",
  ambitoTerritorial: "provincia",
  codigoEntidad:     "00", // código INE de la provincia
  idiomas:        ["es", "en"],
  idioma_defecto: "es",
  branding: {
    logo_cliente:  null,
    logo_empresa:  "../assets/logos/empresa.png",
  },
  herramientas: [
    {
      id:         "distancia",
      componentes: {
        "2D": "arcgis-distance-measurement-2d",
        "3D": "arcgis-direct-line-measurement-3d"
      },
      icono:      "measure-line",
      categoria:  "analisis",
      habilitada: true
    },
    {
      id:         "area",
      componentes: {
        "2D": "arcgis-area-measurement-2d",
        "3D": "arcgis-area-measurement-3d"
      },
      icono:      "measure-area",
      categoria:  "analisis",
      habilitada: true
    },
    {
      id:         "dibujo",
      componente: "arcgis-sketch",
      icono:      "pencil",
      categoria:  "analisis",
      habilitada: true,
      sketchOpciones: {
        availableCreateTools: ["point", "polyline", "polygon", "rectangle", "circle"],
        layout: "horizontal"
      }
    },
    {
      id:         "limpiar",
      componente: null,
      icono:      "trash",
      categoria:  "accion",
      habilitada: true
    }
  ]
};
*/


// ── VARIANTE — MODELO A, ayuntamiento único (1 municipio) ─────────────────
// La app arranca y carga el municipio automáticamente, sin interacción del
// usuario final. Caso mínimo viable: mismo patrón que pamplona/logroño.

/*
export const DEPLOYMENT = {
  mode:           "production",
  cliente:        "ayuntamiento-nombre",
  nombre_visible: "Ayuntamiento de [Nombre]",
  municipios:     ["00000"], // codigo_ine del municipio
  idiomas:        ["es", "en"],
  idioma_defecto: "es",
  branding: {
    logo_cliente:  null,
    logo_empresa:  "../assets/logos/empresa.png",
  },
  herramientas: [
    {
      id:         "distancia",
      componentes: {
        "2D": "arcgis-distance-measurement-2d",
        "3D": "arcgis-direct-line-measurement-3d"
      },
      icono:      "measure-line",
      categoria:  "analisis",
      habilitada: true
    },
    {
      id:         "limpiar",
      componente: null,
      icono:      "trash",
      categoria:  "accion",
      habilitada: true
    }
  ]
};
*/


// ── VARIANTE — MODELO A, mancomunidad/comarca (N municipios) ─────────────
// Lista curada y estable de municipios sin ámbito administrativo superior
// que resolver. Selector activo restringido a esa lista.

/*
export const DEPLOYMENT = {
  mode:           "production",
  cliente:        "mancomunidad-nombre",
  nombre_visible: "Mancomunidad de [Nombre]",
  municipios:     ["00000", "00001", "00002"], // codigos_ine del ámbito
  idiomas:        ["es", "en"],
  idioma_defecto: "es",
  branding: {
    logo_cliente:  null,
    logo_empresa:  "../assets/logos/empresa.png",
  },
  herramientas: [] // ejemplo de decisión de producto: panel sin acciones
};
*/


// ── VARIANTE — MODO DEMO (sin restricción, todos los municipios) ─────────
// Para desarrollo y reuniones. No es un cliente real.

/*
export const DEPLOYMENT = {
  mode:           "demo",
  cliente:        "tfm-demo",
  nombre_visible: "Demo TFM — Visor GIS Municipal",
  municipios:     [],
  idiomas:        ["es", "eu", "en"],
  idioma_defecto: "es",
  branding: {
    logo_cliente:  null,
    logo_empresa:  "../assets/logos/bilbomatica.svg",
  },
  herramientas: [
    {
      id:         "distancia",
      componentes: {
        "2D": "arcgis-distance-measurement-2d",
        "3D": "arcgis-direct-line-measurement-3d"
      },
      icono:      "measure-line",
      categoria:  "analisis",
      habilitada: true
    },
    {
      id:         "area",
      componentes: {
        "2D": "arcgis-area-measurement-2d",
        "3D": "arcgis-area-measurement-3d"
      },
      icono:      "measure-area",
      categoria:  "analisis",
      habilitada: true
    },
    {
      id:         "dibujo",
      componente: "arcgis-sketch",
      icono:      "pencil",
      categoria:  "analisis",
      habilitada: true,
      sketchOpciones: {
        availableCreateTools: ["point", "polyline", "polygon", "rectangle", "circle"],
        layout: "horizontal"
      }
    },
    {
      id:         "imprimir",
      componente: "arcgis-print",
      icono:      "print",
      categoria:  "exportar",
      habilitada: false,
    },
    {
      id:         "limpiar",
      componente: null,
      icono:      "trash",
      categoria:  "accion",
      habilitada: true
    }
  ]
};
*/