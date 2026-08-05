"""
tools/generar_geografia.py
===========================
Lee los shapefiles oficiales del IGN (recintos INSPIRE — municipal,
provincial, autonómico) y genera JSON de datos geográficos según los
niveles y códigos que se pidan por línea de comandos:

    data/municipios.json
    data/provincias.json
    data/ccaa.json
    data/municipios_<nombre_provincia>.json   ← NUEVO: todos los
                                                  municipios de una
                                                  provincia completa

Solo se regenera el archivo del nivel que se pida explícitamente —
si un flag se omite, el JSON existente de ese nivel no se toca.

Uso:
    # Preset de la demo actual (10 municipios ya usados en el prototipo)
    python tools/generar_geografia.py --municipios demo

    # Códigos INE de municipio sueltos
    python tools/generar_geografia.py --municipios 31201,31232

    # CCAA por código INE de comunidad autónoma
    python tools/generar_geografia.py --ccaa 15,17

    # Provincias por código INE de provincia (genera el POLÍGONO de
    # la provincia entera, para el ámbito territorial "provincia")
    python tools/generar_geografia.py --provincias 48

    # Todos los municipios de una o varias provincias, cada provincia en
    # su propio archivo, nombrado por código INE (el runtime construye
    # esta ruta solo, desde deployment.codigoEntidad):
    #   data/municipios_31.json   ← Navarra (contiene "provincia_nombre": "Navarra" en cada entry)
    #   data/municipios_48.json   ← Bizkaia
    python tools/generar_geografia.py --municipios-de-provincia 31,48

    # NUEVO — todos los municipios de una o varias CCAA, cada CCAA en su
    # propio archivo (útil cuando la CCAA tiene varias provincias, ej.
    # País Vasco — aquí no hace falta enumerar sus provincias, se filtra
    # directo por ccaa_code del NATCODE):
    #   data/municipios_ccaa_15.json   ← Navarra
    #   data/municipios_ccaa_16.json   ← País Vasco (Álava+Gipuzkoa+Bizkaia, sin listar nada a mano)
    python tools/generar_geografia.py --municipios-de-ccaa 15,16

    # Combinado — caso real de prueba de ámbitos territoriales:
    python tools/generar_geografia.py \\
        --municipios demo \\
        --ccaa 15,17 \\
        --provincias 48

Requisitos:
    pip install pyshp shapely

Fuente de los shapefiles:
    Centro de Descargas IGN — "Límites municipales, provinciales y autonómicos"
    https://centrodedescargas.cnig.es/CentroDescargas/limites-municipales-provinciales-autonomicos

    Carpetas esperadas en data/SHP_ETRS89/:
        recintos_municipales_inspire_peninbal_etrs89/
        recintos_provinciales_inspire_peninbal_etrs89/
        recintos_autonomicas_inspire_peninbal_etrs89/

Diseño (ver 3DECISIONS.md, sesión de migración a JSON + generalización CLI):
    - Un único NATCODE (11 dígitos, tras quitar prefijo "ES") codifica
      los tres niveles administrativos en posiciones fijas:
          [0:2]  → "34" (prefijo constante IGN, se descarta)
          [2:4]  → ccaa_code       (presente en los 3 niveles)
          [4:6]  → provincia_code  ("00" en el nivel CCAA)
          [6:11] → codigo_ine      ("00000" en CCAA y provincia)
      Esto reemplaza la tabla manual PROVINCIA_A_CCAA que existía en la
      versión anterior del script — una sola fuente de verdad (el propio
      IGN), sin tabla editorial que pueda desincronizarse.
    - Los JSON generados NO incluyen ruta de logo. La resolución de logo
      de municipio se decidió en runtime (frontend, ui/municipioSelector.js,
      fallback en cascada de extensión) para desacoplar geometría de
      presentación — ver 4STATUS.md, "Resolución de logo de municipio".
    - CCAA y provincia son niveles administrativos distintos: "Bizkaia"
      es provincia, no CCAA (la CCAA correspondiente es País Vasco/Euskadi,
      código 16). El script no intenta adivinar equivalencias — cada
      código pasado por --ccaa se busca tal cual en el nivel autonómico,
      y cada código de --provincias en el nivel provincial.
    - NUEVO (--municipios-de-provincia / --municipios-de-ccaa): a
      diferencia de --municipios, que exige que TÚ ya sepas y escribas
      la lista de códigos INE, estos modos filtran el shapefile
      municipal por provincia_code o ccaa_code (según el caso) y se
      quedan con TODOS los que encuentren. Es un filtro 1-a-muchos (una
      provincia o CCAA → decenas/cientos de municipios), así que
      necesita su propia función de lectura — ver
      `leer_municipios_agrupados()` más abajo. El caso CCAA NUNCA pasa
      por el shapefile provincial: cada municipio ya trae su propio
      ccaa_code directo en el NATCODE, así que no hace falta resolver
      primero "qué provincias tiene esta CCAA" — se filtra directo.
"""

import argparse
import json
import sys
from pathlib import Path

import shapefile                          # pyshp — lee archivos .shp/.dbf
from shapely.geometry import shape, MultiPolygon, Polygon
from shapely.ops import unary_union

# ---------------------------------------------------------------------------
# Rutas
# ---------------------------------------------------------------------------
# __file__ es la ruta de este script. .parent sube un nivel, así que
# SCRIPT_DIR = tools/, y DATA_DIR = la carpeta data/ hermana de tools/.
# Se calcula así (en vez de escribir rutas fijas) para que el script
# funcione igual sin importar desde qué carpeta lo ejecutes.

SCRIPT_DIR = Path(__file__).parent
DATA_DIR   = SCRIPT_DIR.parent / "data"
SHP_DIR    = DATA_DIR / "SHP_ETRS89"

# Rutas a los 3 shapefiles oficiales del IGN. Cada shapefile es en
# realidad un conjunto de varios archivos (.shp, .dbf, .shx, etc.)
# que comparten nombre — pyshp solo necesita la ruta al .shp.
SHP_MUNICIPAL   = SHP_DIR / "recintos_municipales_inspire_peninbal_etrs89"   / "recintos_municipales_inspire_peninbal_etrs89.shp"
SHP_PROVINCIAL  = SHP_DIR / "recintos_provinciales_inspire_peninbal_etrs89"  / "recintos_provinciales_inspire_peninbal_etrs89.shp"
SHP_AUTONOMICO  = SHP_DIR / "recintos_autonomicas_inspire_peninbal_etrs89"   / "recintos_autonomicas_inspire_peninbal_etrs89.shp"

# Rutas de salida para los modos "clásicos" (listas explícitas de códigos).
OUT_MUNICIPIOS  = DATA_DIR / "municipios.json"
OUT_PROVINCIAS  = DATA_DIR / "provincias.json"
OUT_CCAA        = DATA_DIR / "ccaa.json"

# TOLERANCE controla cuánto se "suaviza"/simplifica el contorno de cada
# polígono. Es en grados (porque las coordenadas están en WGS84 lon/lat),
# y 0.001° equivale aproximadamente a 100 metros en latitudes de España.
# Sin esto, los polígonos del IGN traen miles de vértices — demasiado
# detalle para un mapa web, y penaliza el rendimiento del navegador.
TOLERANCE = 0.001   # ~100 m. Reduce vértices manteniendo forma reconocible.

# ---------------------------------------------------------------------------
# Preset "demo" — los municipios ya usados en el prototipo actual.
# Se mantiene como preset CON NOMBRE (no como valor por defecto oculto)
# para que en el comando quede explícito qué se está generando y por qué.
# Así, quien lea el historial de comandos entiende la intención sin
# tener que abrir el código.
# ---------------------------------------------------------------------------

PRESET_MUNICIPIOS_DEMO = [
    "48020",   # Bilbao
    "20069",   # Donostia/San Sebastián
    "01059",   # Vitoria-Gasteiz
    "48013",   # Barakaldo
    "48044",   # Getxo
    "31201",   # Pamplona/Iruña
    "31232",   # Tudela
    "31084",   # Estella/Lizarra
    "26089",   # Logroño
    "09059",   # Burgos
]

# ---------------------------------------------------------------------------
# NATCODE — extracción por posición fija
# ---------------------------------------------------------------------------
# El campo NATCODE de los shapefiles del IGN es un string donde cada
# tramo de caracteres representa un nivel administrativo. Por ejemplo,
# para Pamplona podría verse algo como "ES34150031201" (11 dígitos tras
# quitar el prefijo "ES"). Estas 3 funciones son simplemente "recortes"
# de ese string en las posiciones que corresponden a cada nivel —
# NO hacen ninguna consulta a tabla externa, es pura aritmética de texto.

def _limpiar_natcode(valor_raw: str) -> str:
    """Quita espacios y el prefijo 'ES' si existe. Devuelve string de 11 dígitos."""
    v = str(valor_raw).strip()
    if v.startswith("ES"):
        v = v[2:]
    return v


def ccaa_code_de(natcode: str) -> str:
    """Posiciones [2:4] del NATCODE limpio → código INE de comunidad autónoma."""
    return _limpiar_natcode(natcode)[2:4]


def provincia_code_de(natcode: str) -> str:
    """Posiciones [4:6] del NATCODE limpio → código INE de provincia."""
    return _limpiar_natcode(natcode)[4:6]


def codigo_ine_de(natcode: str) -> str:
    """Posiciones [6:11] del NATCODE limpio → código INE de municipio."""
    return _limpiar_natcode(natcode)[6:11]


# ---------------------------------------------------------------------------
# Lectura de shapefile — CASO 1-A-1 (un código → un registro)
# ---------------------------------------------------------------------------
# Esta función sirve para los casos donde el filtro es "uno a uno":
# le pasas un código de municipio y esperas UN municipio de vuelta,
# o un código de CCAA y esperas UNA comunidad autónoma de vuelta.
# Por eso el resultado es un diccionario plano { codigo: registro }.

def leer_shp(shp_path: Path, campo_codigo_objetivo, codigos_objetivo: set) -> dict:
    """
    Lee un shapefile IGN y devuelve solo los registros cuyo código
    (calculado con `campo_codigo_objetivo`, una de las funciones
    ccaa_code_de / provincia_code_de / codigo_ine_de) está en
    `codigos_objetivo`.

    Devuelve: { codigo: { "natcode": str, "nombre": str, "geom": geojson } }

    OJO: esto asume que cada código objetivo aparece UNA sola vez en el
    shapefile (por eso el resultado es un dict plano). Si el mismo código
    pudiera repetirse varias veces —como pasa al filtrar municipios por
    PROVINCIA, donde hay decenas de municipios por cada provincia—, esta
    función NO sirve: cada coincidencia nueva pisaría (sobrescribiría) a
    la anterior en el dict. Para ese caso 1-a-muchos existe la función
    hermana `leer_municipios_agrupados()` más abajo.
    """
    if not shp_path.exists():
        print(f"\nERROR: Shapefile no encontrado en:\n  {shp_path}")
        sys.exit(1)

    print(f"Leyendo shapefile: {shp_path.name}")
    sf     = shapefile.Reader(str(shp_path), encoding="utf-8")
    fields = [f[0] for f in sf.fields[1:]]   # [1:] porque el primer campo de pyshp es un campo interno "DeletionFlag", no un dato real

    if "NATCODE" not in fields or "NAMEUNIT" not in fields:
        print(f"  ERROR: Campos esperados no encontrados. Campos disponibles: {fields}")
        sys.exit(1)

    idx_natcode = fields.index("NATCODE")
    idx_nombre  = fields.index("NAMEUNIT")

    resultados   = {}
    total_leidos = 0

    # iterShapeRecords() recorre el shapefile registro por registro sin
    # cargar todo en memoria de golpe — importante porque el shapefile
    # nacional de municipios tiene más de 8000 registros.
    for sr in sf.iterShapeRecords():
        total_leidos += 1
        natcode_raw = str(sr.record[idx_natcode]).strip()
        codigo = campo_codigo_objetivo(natcode_raw)   # aplica ccaa_code_de / provincia_code_de / codigo_ine_de

        if codigo not in codigos_objetivo:
            continue   # no es uno de los códigos que buscamos, se descarta

        nombre = str(sr.record[idx_nombre]).strip()
        geom   = sr.shape.__geo_interface__   # geometría en formato GeoJSON estándar

        resultados[codigo] = {
            "natcode": _limpiar_natcode(natcode_raw),
            "nombre": nombre,
            "geom": geom,
        }
        print(f"  Encontrado: {codigo} — {nombre}")

    print(f"  Registros leídos: {total_leidos} | Coincidencias: {len(resultados)}")
    return resultados


# ---------------------------------------------------------------------------
# Lectura de shapefile — CASO 1-A-MUCHOS (una provincia → varios municipios)
# ---------------------------------------------------------------------------
# NUEVO. Esta es la pieza que faltaba para "todos los municipios de
# Navarra y Bizkaia". A diferencia de leer_shp(), aquí NO conocemos de
# antemano los códigos INE de municipio que vamos a encontrar — solo
# conocemos la provincia. Por eso el resultado no puede ser un dict
# plano {codigo_ine: registro}: tiene que ser {provincia_code: [lista
# de municipios encontrados en esa provincia]}.

def leer_municipios_agrupados(campo_codigo_objetivo, codigos_objetivo: set) -> dict:
    """
    Lee el shapefile MUNICIPAL completo y agrupa cada municipio encontrado
    bajo el código calculado con `campo_codigo_objetivo` — la misma función
    que ya usa leer_shp() (provincia_code_de / ccaa_code_de), pero aquí el
    resultado es una LISTA por código, no un registro único, porque el
    filtro es 1-a-muchos: una provincia o una CCAA agrupan muchos municipios.

    Generalización de la versión anterior (que solo agrupaba por provincia):
    ahora sirve tanto para "todos los municipios de esta provincia" como
    para "todos los municipios de esta CCAA", pasando provincia_code_de o
    ccaa_code_de según el caso — evita tener dos funciones casi idénticas
    que solo difieren en qué recorte del NATCODE usan para agrupar.

    Devuelve:
        {
          "31": [ {natcode, nombre, geom}, {natcode, nombre, geom}, ... ],
          "48": [ {natcode, nombre, geom}, ... ],
        }
    """
    if not SHP_MUNICIPAL.exists():
        print(f"\nERROR: Shapefile no encontrado en:\n  {SHP_MUNICIPAL}")
        sys.exit(1)

    print(f"Leyendo shapefile: {SHP_MUNICIPAL.name}")
    sf     = shapefile.Reader(str(SHP_MUNICIPAL), encoding="utf-8")
    fields = [f[0] for f in sf.fields[1:]]
    idx_natcode = fields.index("NATCODE")
    idx_nombre  = fields.index("NAMEUNIT")

    # Se inicializa cada código pedido con una lista vacía. Así, si algún
    # código no tiene NINGÚN municipio (por ejemplo, un código mal escrito),
    # el resultado lo deja claro con lista vacía en vez de simplemente no
    # aparecer en el diccionario.
    resultados = {codigo: [] for codigo in codigos_objetivo}
    total_leidos = 0

    for sr in sf.iterShapeRecords():
        total_leidos += 1
        natcode_raw = str(sr.record[idx_natcode]).strip()
        codigo = campo_codigo_objetivo(natcode_raw)   # provincia_code_de o ccaa_code_de, según quien llame

        if codigo not in codigos_objetivo:
            continue   # este municipio no pertenece a ninguno de los códigos pedidos

        resultados[codigo].append({
            "natcode": _limpiar_natcode(natcode_raw),
            "nombre": str(sr.record[idx_nombre]).strip(),
            "geom": sr.shape.__geo_interface__,
        })

    print(f"  Registros leídos: {total_leidos}")
    for codigo, lista in resultados.items():
        print(f"  Código {codigo}: {len(lista)} municipios encontrados")

    return resultados


# ---------------------------------------------------------------------------
# Geometría (agnóstica a nivel — misma función para municipio/provincia/ccaa)
# ---------------------------------------------------------------------------

def simplify_to_rings(geom_json: dict, tolerance: float) -> list:
    """
    Simplifica la geometría y devuelve rings en formato ArcGIS:
        [[[lon, lat], ...], ...]

    MultiPolygon → unary_union antes de simplificar para evitar
    rings de enclaves que complican la máscara donut de mapManager.
    preserve_topology=True evita auto-intersecciones (que romperían
    el polígono al dibujarlo).
    """
    geom = shape(geom_json)   # convierte el dict GeoJSON a un objeto shapely

    if isinstance(geom, MultiPolygon):
        # Un municipio con varias "islas" separadas (por ejemplo, un
        # exclave) llega como MultiPolygon. unary_union fusiona todo
        # en una sola geometría antes de simplificar, para que la
        # simplificación no trate cada isla como algo independiente.
        geom = unary_union(geom)

    simplified = geom.simplify(tolerance, preserve_topology=True)

    if simplified.is_empty:
        # Salvaguarda: si la simplificación deja la geometría vacía
        # (pasa con polígonos muy pequeños y tolerance muy alto),
        # se usa la geometría original sin simplificar en vez de
        # perder el municipio por completo.
        simplified = geom

    def poly_to_rings(poly: Polygon) -> list:
        rings = []
        # El anillo exterior (el contorno del municipio)
        rings.append([[round(x, 6), round(y, 6)] for x, y in poly.exterior.coords])
        # Los anillos interiores (agujeros dentro del municipio, si los hay
        # — por ejemplo, un municipio que rodea completamente a otro)
        for interior in poly.interiors:
            rings.append([[round(x, 6), round(y, 6)] for x, y in interior.coords])
        return rings

    if isinstance(simplified, Polygon):
        return poly_to_rings(simplified)
    elif isinstance(simplified, MultiPolygon):
        rings = []
        for part in simplified.geoms:
            rings.extend(poly_to_rings(part))
        return rings
    else:
        # Caso extremo (geometría degenerada): se devuelve el
        # rectángulo (bounding box) como polígono de respaldo,
        # para que el municipio nunca quede sin ninguna geometría.
        b = simplified.bounds
        return [[[b[0], b[1]], [b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]]]


def compute_bbox(rings: list) -> list:
    """[xmin, ymin, xmax, ymax] calculado desde los rings del polígono."""
    all_coords = [c for ring in rings for c in ring]
    xs = [c[0] for c in all_coords]
    ys = [c[1] for c in all_coords]
    return [round(min(xs), 6), round(min(ys), 6),
            round(max(xs), 6), round(max(ys), 6)]


# ---------------------------------------------------------------------------
# Construcción de la entry de salida para UN municipio
# ---------------------------------------------------------------------------
# Caché de nombres de provincia — memoizado a nivel de módulo
# ---------------------------------------------------------------------------
# NUEVO. _construir_entry_municipio() necesita el nombre legible de la
# provincia de CADA municipio (para el campo "provincia_nombre", que ahora
# se usa no solo para búsqueda humana sino también para AGRUPAR el selector
# de municipio en el frontend por provincia — ver ui/municipioSelector.js).
# En vez de leer el shapefile provincial una vez por cada municipio (miles
# de lecturas redundantes), se lee UNA sola vez la primera vez que se pide
# un nombre, y se cachea en este dict a nivel de módulo para el resto de
# la ejecución del script.

_CACHE_NOMBRES_PROVINCIA = None


def _obtener_nombre_provincia(provincia_code: str) -> str:
    """
    Devuelve el nombre legible de una provincia (ej. "Navarra") a partir
    de su código INE (ej. "31"). Si no se encuentra, devuelve el propio
    código como respaldo en vez de fallar — un nombre feo es preferible
    a que el script se caiga por un dato secundario (no geométrico).
    """
    global _CACHE_NOMBRES_PROVINCIA

    if _CACHE_NOMBRES_PROVINCIA is None:
        if not SHP_PROVINCIAL.exists():
            print(f"\nERROR: Shapefile no encontrado en:\n  {SHP_PROVINCIAL}")
            sys.exit(1)

        sf     = shapefile.Reader(str(SHP_PROVINCIAL), encoding="utf-8")
        fields = [f[0] for f in sf.fields[1:]]
        idx_natcode = fields.index("NATCODE")
        idx_nombre  = fields.index("NAMEUNIT")

        _CACHE_NOMBRES_PROVINCIA = {}
        for sr in sf.iterShapeRecords():
            natcode_raw = str(sr.record[idx_natcode]).strip()
            codigo = provincia_code_de(natcode_raw)
            _CACHE_NOMBRES_PROVINCIA[codigo] = str(sr.record[idx_nombre]).strip()

    return _CACHE_NOMBRES_PROVINCIA.get(provincia_code, provincia_code)


# ---------------------------------------------------------------------------
# NUEVO (extraído). Antes esta lógica estaba escrita directamente dentro
# de generar_municipios(). Se saca a una función aparte porque ahora
# TAMBIÉN la necesita generar_municipios_de_provincia() y
# generar_municipios_de_ccaa() — si la dejáramos duplicada en varios
# sitios, cualquier cambio futuro (por ejemplo, añadir un campo nuevo al
# JSON) habría que hacerlo varias veces y sería fácil olvidar una. Esto
# es aplicar el principio DRY.

def _construir_entry_municipio(codigo_ine: str, registro: dict) -> dict:
    """
    Recibe el código INE y el registro crudo leído del shapefile
    ({natcode, nombre, geom}) y devuelve el dict final con la forma
    exacta que espera el frontend (territorioResolver.js / configEngine).

    "provincia_nombre" se incluye SIEMPRE, sin importar qué comando CLI
    generó esta entry — antes solo se añadía a mano en
    generar_municipios_de_provincia(), lo cual dejaba sin ese dato a los
    municipios generados por --municipios (modo demo) o
    --municipios-de-ccaa. Moverlo aquí, al centro, es lo que permite que
    el frontend agrupe el selector por provincia sin importar el ámbito
    del deployment activo.
    """
    rings = simplify_to_rings(registro["geom"], TOLERANCE)
    bbox  = compute_bbox(rings)
    provincia_code = provincia_code_de(registro["natcode"])
    return {
        "codigo_ine": codigo_ine,
        "nombre": registro["nombre"],
        "provincia_code": provincia_code,
        "provincia_nombre": _obtener_nombre_provincia(provincia_code),
        "ccaa_code": ccaa_code_de(registro["natcode"]),
        "bbox": bbox,
        "polygon": {
            "rings": rings,
            "spatialReference": {"wkid": 4326}   # WGS84 — el mismo sistema de coordenadas que usa el resto de la app
        }
    }



# ---------------------------------------------------------------------------
# Generadores por nivel — comparten leer_shp / simplify_to_rings / compute_bbox
# ---------------------------------------------------------------------------

def generar_municipios(codigos: list) -> list:
    """Modo clásico: recibe una lista explícita de códigos INE de municipio."""
    print("\n--- Nivel: MUNICIPIOS ---")
    datos = leer_shp(SHP_MUNICIPAL, codigo_ine_de, set(codigos))

    entries = []
    for codigo_ine in codigos:
        if codigo_ine not in datos:
            print(f"  ✗  {codigo_ine} — no encontrado")
            continue

        entry = _construir_entry_municipio(codigo_ine, datos[codigo_ine])
        entries.append(entry)
        print(f"  ✓  {entry['nombre']} ({codigo_ine}) | prov={entry['provincia_code']} "
              f"ccaa={entry['ccaa_code']} | {sum(len(r) for r in entry['polygon']['rings'])} vértices")

    return entries


def generar_provincias(codigos: list) -> list:
    """Genera el POLÍGONO de cada provincia entera (para provincias.json)."""
    print("\n--- Nivel: PROVINCIAS ---")
    datos = leer_shp(SHP_PROVINCIAL, provincia_code_de, set(codigos))

    entries = []
    for codigo in codigos:
        if codigo not in datos:
            print(f"  ✗  {codigo} — no encontrado")
            continue

        d = datos[codigo]
        rings = simplify_to_rings(d["geom"], TOLERANCE)
        bbox  = compute_bbox(rings)

        entries.append({
            "tipo": "provincia",
            "provincia_code": codigo,
            "ccaa_code": ccaa_code_de(d["natcode"]),
            "nombre": d["nombre"],
            "bbox": bbox,
            "polygon": {
                "rings": rings,
                "spatialReference": {"wkid": 4326}
            }
        })
        print(f"  ✓  {d['nombre']} ({codigo}) | ccaa={ccaa_code_de(d['natcode'])} "
              f"| {sum(len(r) for r in rings)} vértices")

    return entries


def generar_ccaa(codigos: list) -> list:
    """Genera el POLÍGONO de cada comunidad autónoma entera (para ccaa.json)."""
    print("\n--- Nivel: CCAA ---")
    datos = leer_shp(SHP_AUTONOMICO, ccaa_code_de, set(codigos))

    entries = []
    for codigo in codigos:
        if codigo not in datos:
            print(f"  ✗  {codigo} — no encontrado")
            continue

        d = datos[codigo]
        rings = simplify_to_rings(d["geom"], TOLERANCE)
        bbox  = compute_bbox(rings)

        entries.append({
            "tipo": "ccaa",
            "ccaa_code": codigo,
            "nombre": d["nombre"],
            "bbox": bbox,
            "polygon": {
                "rings": rings,
                "spatialReference": {"wkid": 4326}
            }
        })
        print(f"  ✓  {d['nombre']} ({codigo}) | {sum(len(r) for r in rings)} vértices")

    return entries


def generar_municipios_de_provincia(codigos_provincia: list):
    """
    NUEVO. Genera un archivo municipios_<nombre>.json por cada provincia
    pedida, con TODOS los municipios reales de esa provincia (no una
    lista escrita a mano).

    A diferencia de los otros 3 generadores, esta función NO devuelve
    una lista de entries — escribe directamente uno o varios archivos,
    porque cada provincia necesita su PROPIO archivo de salida (principio
    de "cada cliente solo conoce sus datos": Navarra nunca debe ver los
    municipios de Bizkaia en su JSON, y viceversa).
    """
    print("\n--- Nivel: MUNICIPIOS POR PROVINCIA (todos los municipios reales) ---")

    # Paso 1: necesitamos el NOMBRE de cada provincia (ej. "Navarra",
    # "Bizkaia") para poder nombrar el archivo de salida. Ese nombre
    # vive en el shapefile PROVINCIAL, no en el municipal — por eso se
    # hace una lectura aparte, reutilizando leer_shp() normal (aquí sí
    # es un caso 1-a-1: un código de provincia → un solo registro de
    # provincia).
    info_provincias = leer_shp(SHP_PROVINCIAL, provincia_code_de, set(codigos_provincia))

    # Paso 2: leer TODOS los municipios del shapefile municipal,
    # agrupados por provincia. Esta es la parte "cara" (recorre miles
    # de registros), así que se hace una sola vez para todas las
    # provincias pedidas, no una vez por provincia.
    municipios_por_provincia = leer_municipios_agrupados(provincia_code_de, set(codigos_provincia))

    # Paso 3: por cada provincia pedida, construir sus entries y
    # escribir su propio archivo JSON.
    for codigo in codigos_provincia:
        registros = municipios_por_provincia.get(codigo, [])

        if not registros:
            print(f"  ✗  Provincia {codigo} — sin municipios encontrados (¿código correcto?)")
            continue

        # Nombre bonito de la provincia (ej. "Navarra"). Si por algún
        # motivo no se encontró el registro de la provincia (código raro),
        # se usa el propio código como respaldo en vez de romper el script.
        nombre_provincia = info_provincias.get(codigo, {}).get("nombre", codigo)

        # Se construye la entry de cada municipio encontrado. Nótese
        # que aquí el codigo_ine SÍ lo sacamos del propio registro
        # (codigo_ine_de(r["natcode"])) — a diferencia de
        # generar_municipios(), donde el código INE ya lo conocíamos
        # de antemano porque el usuario lo escribió en --municipios.
        #
        # "provincia_nombre" ya viene incluido automáticamente desde
        # _construir_entry_municipio() (ver ese docstring) — no hace
        # falta añadirlo a mano aquí como en la versión anterior.
        entries = [
            _construir_entry_municipio(codigo_ine_de(r["natcode"]), r)
            for r in registros
        ]

        # NUEVO: nombre de archivo por CÓDIGO INE, no por slug de texto.
        # Por qué: el runtime (territorioResolver.js) conoce el código
        # de la provincia desde deployment.codigoEntidad, así que puede
        # construir la ruta del archivo con una simple interpolación
        # (`municipios_${codigo}.json`) sin necesitar ningún mapeo
        # código→nombre adicional en el frontend. Esto evita tener dos
        # fuentes de verdad (el nombre del archivo y el código en
        # deployment.js) que podrían desincronizarse — el mismo criterio
        # que ya se aplicó al eliminar la tabla PROVINCIA_A_CCAA.
        out_path = DATA_DIR / f"municipios_{codigo}.json"
        escribir_json(entries, out_path, f"municipios de {nombre_provincia} (provincia {codigo})")


def generar_municipios_de_ccaa(codigos_ccaa: list):
    """
    NUEVO. Genera un archivo municipios_ccaa_<codigo>.json por cada CCAA
    pedida, con TODOS los municipios reales de esa comunidad autónoma —
    sin importar cuántas provincias la compongan.

    Por qué esto NO pasa por el shapefile provincial en absoluto:
    cada municipio ya trae su propio ccaa_code directo en su NATCODE
    (posiciones [2:4] — ver docstring del módulo). No hace falta primero
    preguntar "¿qué provincias tiene esta CCAA?" para luego preguntar
    "¿qué municipios tiene cada provincia?" — eso sería una vuelta
    innecesaria (y el motivo por el que se descartó la fusión en runtime
    — ver 3DECISIONS.md). Se filtra el shapefile municipal DIRECTO por
    ccaa_code_de(NATCODE), en un único paso, igual de simple para una CCAA
    uniprovincial (Navarra) que para una multiprovincial (País Vasco).
    """
    print("\n--- Nivel: MUNICIPIOS POR CCAA (todos los municipios reales) ---")

    # Nombre de cada CCAA (ej. "Navarra"), para el campo "ccaa_nombre" en
    # cada municipio — mismo propósito que "provincia_nombre": solo para
    # búsqueda humana, el runtime no lo necesita.
    info_ccaa = leer_shp(SHP_AUTONOMICO, ccaa_code_de, set(codigos_ccaa))

    # Todos los municipios de España, agrupados por ccaa_code en un único
    # recorrido del shapefile municipal.
    municipios_por_ccaa = leer_municipios_agrupados(ccaa_code_de, set(codigos_ccaa))

    for codigo in codigos_ccaa:
        registros = municipios_por_ccaa.get(codigo, [])

        if not registros:
            print(f"  ✗  CCAA {codigo} — sin municipios encontrados (¿código correcto?)")
            continue

        nombre_ccaa = info_ccaa.get(codigo, {}).get("nombre", codigo)

        entries = []
        for r in registros:
            entry = _construir_entry_municipio(codigo_ine_de(r["natcode"]), r)
            entry["ccaa_nombre"] = nombre_ccaa
            entries.append(entry)

        out_path = DATA_DIR / f"municipios_ccaa_{codigo}.json"
        escribir_json(entries, out_path, f"municipios de {nombre_ccaa} (CCAA {codigo})")


# ---------------------------------------------------------------------------
# Escritura JSON
# ---------------------------------------------------------------------------

def _fusionar_con_existente(entries_nuevas: list, output_path: Path, campo_clave: str) -> list:
    """
    Fusiona entries_nuevas con lo que ya exista en output_path, en vez de
    reemplazar el archivo completo. Se usa en los 3 archivos "acumulativos"
    (municipios.json, provincias.json, ccaa.json) — donde cada corrida del
    script suele añadir un territorio más a los que ya había, y perder los
    anteriores por sobrescritura sería un bug silencioso y fácil de no notar.

    Regla de fusión, por campo_clave (ej. "provincia_code"):
      - Si una entry nueva tiene la misma clave que una existente, la nueva
        REEMPLAZA a la vieja (por si el shapefile cambió y quieres refrescar
        ese territorio puntual).
      - Si una entry existente no aparece en las nuevas, se CONSERVA tal cual.
      - Si una entry nueva no existía antes, se AGREGA.

    NO se usa en municipios_<code>.json ni municipios_ccaa_<code>.json:
    esos archivos son de alcance único (siempre representan TODOS los
    municipios de una provincia/CCAA concreta), así que ahí sí tiene
    sentido regenerar el archivo completo en cada corrida.
    """
    if not output_path.exists():
        return entries_nuevas   # primera vez que se genera este archivo — nada que fusionar

    existentes = json.loads(output_path.read_text(encoding="utf-8"))

    # Se indexa lo existente por su clave, para poder sobrescribir por
    # clave en vez de por posición en la lista.
    por_clave = {e[campo_clave]: e for e in existentes}

    for nueva in entries_nuevas:
        por_clave[nueva[campo_clave]] = nueva   # agrega si es nueva, reemplaza si ya existía

    return list(por_clave.values())


def escribir_json(entries: list, output_path: Path, descripcion: str, campo_clave: str = None):
    """
    @param campo_clave: si se indica (ej. "provincia_code"), el archivo se
        FUSIONA con el contenido existente en vez de sobrescribirlo — ver
        _fusionar_con_existente(). Si se omite (None), el comportamiento es
        el de siempre: reemplazar el archivo completo. Los generadores por
        provincia/CCAA (municipios_<code>.json, municipios_ccaa_<code>.json)
        deliberadamente NO pasan este parámetro.
    """
    if campo_clave:
        entries = _fusionar_con_existente(entries, output_path, campo_clave)

    # mkdir(parents=True, exist_ok=True): crea la carpeta data/ si no
    # existiera todavía, y no falla si ya existe (exist_ok=True evita
    # que lance un error por algo que no es realmente un problema).
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"✓  {len(entries)} {descripcion} escritos → {output_path}")


# ---------------------------------------------------------------------------
# CLI — interpretación de los argumentos de línea de comandos
# ---------------------------------------------------------------------------

def _parsear_lista_codigos(valor: str) -> list:
    """'15,17,31' → ['15','17','31']. Espacios y vacíos se ignoran."""
    return [c.strip() for c in valor.split(",") if c.strip()]


def main():
    parser = argparse.ArgumentParser(
        description="Genera municipios.json / provincias.json / ccaa.json desde shapefiles IGN.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--municipios",
        type=str,
        default=None,
        help="Códigos INE de municipio separados por coma, o la palabra 'demo' "
             "para usar el preset de municipios ya usados en el prototipo."
    )
    parser.add_argument(
        "--provincias",
        type=str,
        default=None,
        help="Códigos INE de provincia separados por coma (ej. 48 para Bizkaia). "
             "Genera el POLÍGONO de la provincia entera (para el ámbito 'provincia')."
    )
    parser.add_argument(
        "--ccaa",
        type=str,
        default=None,
        help="Códigos INE de comunidad autónoma separados por coma (ej. 15,17)."
    )
    parser.add_argument(
        "--municipios-de-provincia",
        type=str,
        default=None,
        help="NUEVO. Códigos INE de provincia separados por coma (ej. 31,48). "
             "Genera un archivo municipios_<codigo>.json POR CADA provincia "
             "(ej. municipios_31.json), con TODOS sus municipios reales — "
             "a diferencia de --municipios, aquí no necesitas escribir la "
             "lista de municipios a mano. Cada municipio incluye además "
             "'provincia_nombre' para facilitar la búsqueda humana en el archivo."
    )
    parser.add_argument(
        "--municipios-de-ccaa",
        type=str,
        default=None,
        help="NUEVO. Códigos INE de comunidad autónoma separados por coma "
             "(ej. 15,16). Genera un archivo municipios_ccaa_<codigo>.json "
             "POR CADA CCAA (ej. municipios_ccaa_16.json), con TODOS sus "
             "municipios reales — sin importar cuántas provincias la "
             "compongan (filtra directo por ccaa_code del NATCODE, no pasa "
             "por el shapefile provincial). Cada municipio incluye además "
             "'ccaa_nombre' para facilitar la búsqueda humana en el archivo."
    )

    args = parser.parse_args()

    # Si no se pasó ningún flag, no tiene sentido seguir — se informa
    # y se corta la ejecución con un mensaje de ayuda.
    if not args.municipios and not args.provincias and not args.ccaa \
            and not args.municipios_de_provincia and not args.municipios_de_ccaa:
        parser.error(
            "Debes indicar al menos un nivel a generar: --municipios, --provincias, "
            "--ccaa, --municipios-de-provincia o --municipios-de-ccaa.\n"
            "Ejemplo: python tools/generar_geografia.py --municipios-de-ccaa 15,16"
        )

    print("Generando geografía\n")

    resultado_ok = True

    if args.municipios:
        codigos = PRESET_MUNICIPIOS_DEMO if args.municipios.strip().lower() == "demo" \
            else _parsear_lista_codigos(args.municipios)
        entries = generar_municipios(codigos)
        if len(entries) < len(codigos):
            resultado_ok = False
        escribir_json(entries, OUT_MUNICIPIOS, "municipios", campo_clave="codigo_ine")

    if args.provincias:
        codigos = _parsear_lista_codigos(args.provincias)
        entries = generar_provincias(codigos)
        if len(entries) < len(codigos):
            resultado_ok = False
        escribir_json(entries, OUT_PROVINCIAS, "provincias", campo_clave="provincia_code")

    if args.ccaa:
        codigos = _parsear_lista_codigos(args.ccaa)
        entries = generar_ccaa(codigos)
        if len(entries) < len(codigos):
            resultado_ok = False
        escribir_json(entries, OUT_CCAA, "CCAA", campo_clave="ccaa_code")

    if args.municipios_de_provincia:
        codigos = _parsear_lista_codigos(args.municipios_de_provincia)
        # NOTA: este generador escribe sus propios archivos internamente
        # (uno por provincia), así que no se llama a escribir_json() aquí
        # como con los otros niveles — generar_municipios_de_provincia()
        # ya se encarga de todo.
        generar_municipios_de_provincia(codigos)

    if args.municipios_de_ccaa:
        codigos = _parsear_lista_codigos(args.municipios_de_ccaa)
        # Mismo caso que municipios_de_provincia: escribe sus propios
        # archivos internamente (uno por CCAA), no pasa por escribir_json()
        # aquí en main().
        generar_municipios_de_ccaa(codigos)

    print()
    return 0 if resultado_ok else 1


if __name__ == "__main__":
    sys.exit(main())