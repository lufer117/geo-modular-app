/**
 * config/municipios.js
 *
 * Lista manual de municipios disponibles en el prototipo.
 *
 * ── ESTRUCTURA COMPATIBLE CON INE ────────────────────────────────────────
 * Los campos siguen la nomenclatura oficial del INE para que la evolución
 * sea sin fricciones:
 *
 *   Fase actual  → lista manual (~3 municipios, prototipo TFM)
 *   Medio plazo  → JSON INE completo (~8.200 municipios) — misma estructura
 *   Futuro       → API INE en tiempo real                — misma estructura
 *
 * Cambiar de fase = cambiar el origen del array MUNICIPIOS en main.js.
 * Ningún otro módulo sabe de dónde viene la lista.
 *
 * ── CAMPOS EXTRA RESPECTO AL INE ─────────────────────────────────────────
 * Los siguientes campos no existen en el INE y se añaden manualmente:
 *
 *   bbox    → [xmin, ymin, xmax, ymax] en WGS84.
 *             Origen: IGN / estimación sobre ortofoto.
 *             USO: zoom al municipio al seleccionarlo; filtro espacial para
 *             capas FeatureLayer/WFS/GeoJSON (disponibilidad_municipal: BBOX).
 *
 *   polygon → Límite municipal simplificado en WGS84.
 *             USO: máscara visual para capas WMS — geometryEngine.difference()
 *             crea el área exterior (mundo - municipio) que se rellena de gris
 *             semitransparente, creando el efecto de recorte sin alterar la capa.
 *
 * ── SOBRE LOS POLÍGONOS DE PRUEBA ────────────────────────────────────────
 * Para el prototipo se usan polígonos simplificados (hexágonos aproximados)
 * trazados sobre el casco urbano principal. NO representan el límite municipal
 * real (que puede ser muy complejo con enclaves, ríos, etc.).
 *
 * PRODUCCIÓN: obtener geometrías reales de:
 *   IGN Centro de Descargas → "Líneas Límite Municipales"
 *   https://centrodedescargas.cnig.es/CentroDescargas/
 *   Formato recomendado: GeoJSON o Shapefile, proyección WGS84 (EPSG:4326)
 *
 * ── MUNICIPIOS DE PRUEBA SELECCIONADOS ───────────────────────────────────
 *   Pamplona/Iruña → capital autonómica, núcleo urbano compacto
 *   Logroño        → ciudad media, capital de provincia y CCAA uniprovincial
 *   Burgos         → ciudad histórica, datos catastrales y patrimoniales ricos
 */

export const MUNICIPIOS = [

  // ── 1. Pamplona / Iruña ──────────────────────────────────────────────────
  {
    // Identificadores INE
    codigo_ine:       "31201",   // CPRO(31) + CMUN(201)
    nombre:           "Pamplona/Iruña",
    provincia_code:   "31",
    provincia_nombre: "Navarra",
    ccaa_code:        "15",      // Comunidad Foral de Navarra
    ccaa_nombre:      "Comunidad Foral de Navarra",

    // Bounding box WGS84 [xmin, ymin, xmax, ymax]
    // 
    bbox: [-1.895300,42.643216,-1.326937,42.942387],

    // Polígono simplificado para prototipo (hexágono aproximado sobre casco urbano)
    // rings: array de anillos WGS84 [[lon, lat], ...]
    // El primer anillo es el exterior; debe cerrarse (primer punto = último punto)
     polygon: {
      rings: [[
        [-1.683, 42.805], [-1.665, 42.830], [-1.625, 42.835], 
        [-1.595, 42.820], [-1.590, 42.785], [-1.620, 42.770], 
        [-1.660, 42.775], [-1.683, 42.805]
      ]],
      spatialReference: { wkid: 4326 }
    }
  },

  // ── 2. Logroño ───────────────────────────────────────────────────────────
  {
    codigo_ine:       "26089",
    nombre:           "Logroño",
    provincia_code:   "26",
    provincia_nombre: "La Rioja",
    ccaa_code:        "17",
    ccaa_nombre:      "La Rioja",

    bbox: [-2.5460, 42.4180, -2.3790, 42.5060],

    polygon: {
      rings: [[
        [-2.5460, 42.4180],
        [-2.3790, 42.4250],
        [-2.3790, 42.4900],
        [-2.4200, 42.5060],
        [-2.5000, 42.5020],
        [-2.5460, 42.4700],
        [-2.5460, 42.4180]
      ]],
      spatialReference: { wkid: 4326 }
    }
  },

  // ── 3. Burgos ────────────────────────────────────────────────────────────
  {
    codigo_ine:       "09059",
    nombre:           "Burgos",
    provincia_code:   "09",
    provincia_nombre: "Burgos",
    ccaa_code:        "07",
    ccaa_nombre:      "Castilla y León",

    bbox: [-3.7550, 42.2820, -3.6220, 42.3800],

    polygon: {
      rings: [[
        [-3.7550, 42.2820],
        [-3.6220, 42.2900],
        [-3.6220, 42.3600],
        [-3.6600, 42.3800],
        [-3.7200, 42.3750],
        [-3.7550, 42.3400],
        [-3.7550, 42.2820]
      ]],
      spatialReference: { wkid: 4326 }
    }
  }

];