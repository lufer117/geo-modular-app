"""
enriquecer-catalogo.py

Script de enriquecimiento: catalogo-capas.json → catalogo-capas.json (actualizado)

Lee el catálogo generado por migrar-catalogo.py, consulta el GetCapabilities
de cada servicio y añade bbox_real y sublayers bajo la clave _enriquecido.

NO modifica ningún campo declarado manualmente (cobertura.tipo, title, etc.)
Todo el resultado automático va bajo _enriquecido para distinguirlo claramente.

USO:
    python enriquecer-catalogo.py                         # usa catalogo-capas.json por defecto
    python enriquecer-catalogo.py mi-catalogo.json        # archivo personalizado

SALIDA:
    catalogo-capas.json       → catálogo actualizado con _enriquecido en cada capa
    informe-enriquecimiento.txt → resumen de estados por capa

REQUISITOS:
    pip install requests

ESTADOS POSIBLES en _enriquecido.estado:
    ok                  → capabilities consultado y parseado correctamente
    sin_capabilities    → no hay URL de capabilities y no se pudo construir
    error_red           → timeout, conexión rechazada o HTTP error
    xml_invalido        → respuesta recibida pero no es XML parseable
    tipo_no_soportado   → XYZ sin TileJSON, API u otro tipo sin estándar
    ya_enriquecido      → tenía _enriquecido previo (se sobreescribe igualmente)
"""

import sys
import json
import datetime
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse, urlencode, urlunparse, parse_qs, urljoin

try:
    import requests
except ImportError:
    print("❌ Falta 'requests'. Instálala con: pip install requests")
    sys.exit(1)


# ─────────────────────────────────────────────
# CONFIGURACIÓN
# ─────────────────────────────────────────────
TIMEOUT_SEGUNDOS  = 15      # tiempo máximo por petición
ARCHIVO_CATALOGO  = "catalogo-capas-ne.json"
ARCHIVO_INFORME   = "informe-enriquecimiento.txt"

# Namespaces XML por tipo de servicio
NS = {
    "wms":  {
        "wms111": "",                                                # WMS 1.1.1 no usa namespace
        "wms130": "http://www.opengis.net/wms",
    },
    "wmts": {"wmts": "http://www.opengis.net/wmts/1.0",
             "ows":  "http://www.opengis.net/ows/1.1"},
    "wfs":  {"wfs":  "http://www.opengis.net/wfs",
             "wfs2": "http://www.opengis.net/wfs/2.0",
             "ows":  "http://www.opengis.net/ows/1.1"},
    "wcs":  {"wcs":  "http://www.opengis.net/wcs",
             "wcs2": "http://www.opengis.net/wcs/2.0",
             "ows":  "http://www.opengis.net/ows/1.1"},
}


# ─────────────────────────────────────────────
# CONSTRUCCIÓN DE URL DE CAPABILITIES
# ─────────────────────────────────────────────

PARAMS_CAPABILITIES = {
    "WMS":  {"SERVICE": "WMS",  "REQUEST": "GetCapabilities"},
    "WMTS": {"SERVICE": "WMTS", "REQUEST": "GetCapabilities"},
    "WFS":  {"SERVICE": "WFS",  "REQUEST": "GetCapabilities"},
    "WCS":  {"SERVICE": "WCS",  "REQUEST": "GetCapabilities"},
}

def construir_url_capabilities(capa: dict) -> str | None:
    """
    Usa capabilities_url si está disponible.
    Si no, construye la URL añadiendo parámetros estándar a url base.
    Devuelve None si no hay información suficiente.
    """
    caps_url = (capa.get("capabilities_url") or "").strip()
    if caps_url:
        return caps_url

    tipo    = capa.get("tipo", "").upper()
    url_base = (capa.get("url") or "").strip()
    params  = PARAMS_CAPABILITIES.get(tipo)

    if not url_base or not params:
        return None

    # Añade parámetros sin duplicar los que ya estén en la URL base
    parsed   = urlparse(url_base)
    existing = parse_qs(parsed.query)
    merged   = {k.upper(): v for k, v in existing.items()}
    merged.update(params)
    query    = urlencode({k: v[0] if isinstance(v, list) else v for k, v in merged.items()})
    return urlunparse(parsed._replace(query=query))


# ─────────────────────────────────────────────
# PETICIÓN HTTP
# ─────────────────────────────────────────────

def fetch_xml(url: str) -> tuple[ET.Element | None, str]:
    """
    Descarga y parsea XML desde una URL.
    Devuelve (root_element, estado).
    estado puede ser: "ok", "error_red", "xml_invalido"
    """
    try:
        resp = requests.get(url, timeout=TIMEOUT_SEGUNDOS,
                            headers={"User-Agent": "gis-app-catalogo-enricher/1.0"})
        resp.raise_for_status()
    except requests.exceptions.Timeout:
        return None, "error_red: timeout"
    except requests.exceptions.ConnectionError as e:
        return None, f"error_red: {str(e)[:80]}"
    except requests.exceptions.HTTPError as e:
        return None, f"error_red: HTTP {resp.status_code}"
    except Exception as e:
        return None, f"error_red: {str(e)[:80]}"

    try:
        root = ET.fromstring(resp.content)
        return root, "ok"
    except ET.ParseError as e:
        return None, f"xml_invalido: {str(e)[:80]}"


# ─────────────────────────────────────────────
# PARSERS POR TIPO DE SERVICIO
# ─────────────────────────────────────────────

def _bbox_a_lista(minx, miny, maxx, maxy) -> list[float] | None:
    """Convierte strings de coordenadas a lista de floats redondeados."""
    try:
        return [round(float(v), 6) for v in (minx, miny, maxx, maxy)]
    except (ValueError, TypeError):
        return None


def parsear_wms(root: ET.Element) -> dict:
    """
    Parsea GetCapabilities WMS (1.1.1 y 1.3.0).
    Extrae bbox y sublayers de la capa raíz del Capability.
    """
    resultado = {"bbox_real": None, "sublayers": []}

    # WMS 1.3.0 usa namespace; 1.1.1 no
    ns130 = NS["wms"]["wms130"]

    def tag(nombre):
        """Busca con y sin namespace."""
        return [
            root.find(f".//{{{ns130}}}{nombre}"),
            root.find(f".//{nombre}"),
        ]

    # Buscar la primera Layer del Capability (capa raíz)
    capa_raiz = None
    for nodo in [root.find(f".//{{{ns130}}}Capability/{{{ns130}}}Layer"),
                 root.find(".//Capability/Layer")]:
        if nodo is not None:
            capa_raiz = nodo
            break

    if capa_raiz is None:
        return resultado

    # BoundingBox de la capa raíz
    for tag_bbox in [f"{{{ns130}}}EX_GeographicBoundingBox", "EX_GeographicBoundingBox",
                     f"{{{ns130}}}LatLonBoundingBox",         "LatLonBoundingBox"]:
        bbox_el = capa_raiz.find(tag_bbox)
        if bbox_el is not None:
            # EX_GeographicBoundingBox (WMS 1.3.0)
            def txt(nombre):
                for t in [f"{{{ns130}}}{nombre}", nombre]:
                    el = bbox_el.find(t)
                    if el is not None:
                        return el.text
                return bbox_el.get(nombre)

            bbox = _bbox_a_lista(
                txt("westBoundLongitude") or bbox_el.get("minx"),
                txt("southBoundLatitude") or bbox_el.get("miny"),
                txt("eastBoundLongitude") or bbox_el.get("maxx"),
                txt("northBoundLatitude") or bbox_el.get("maxy"),
            )
            if bbox:
                resultado["bbox_real"] = bbox
                break

    # Sublayers (capas hijo de la raíz)
    ns_prefix = f"{{{ns130}}}" if ns130 else ""
    for sublayer in capa_raiz.findall(f"{ns_prefix}Layer") or capa_raiz.findall("Layer"):
        name_el  = sublayer.find(f"{ns_prefix}Name") or sublayer.find("Name")
        title_el = sublayer.find(f"{ns_prefix}Title") or sublayer.find("Title")

        if name_el is None:
            continue

        sub = {
            "name":  (name_el.text  or "").strip(),
            "title": (title_el.text if title_el is not None else "").strip(),
        }

        # BoundingBox del sublayer
        for tag_sub in [f"{ns_prefix}BoundingBox", "BoundingBox"]:
            for bb in sublayer.findall(tag_sub):
                crs = bb.get("CRS") or bb.get("SRS") or ""
                if "4326" in crs or "CRS84" in crs or not crs:
                    bbox_sub = _bbox_a_lista(
                        bb.get("minx") or bb.get("miny"),
                        bb.get("miny") or bb.get("minx"),
                        bb.get("maxx"),
                        bb.get("maxy"),
                    )
                    if bbox_sub:
                        sub["bbox"] = bbox_sub
                    break

        resultado["sublayers"].append(sub)

    return resultado


def parsear_wmts(root: ET.Element) -> dict:
    """
    Parsea GetCapabilities WMTS 1.0.
    Extrae WGS84BoundingBox de cada Layer.
    """
    resultado = {"bbox_real": None, "sublayers": []}
    ows = NS["wmts"]["ows"]

    layers = root.findall(f".//{{{ows}}}Layer") or root.findall(".//Layer")
    if not layers:
        # Intento alternativo con namespace WMTS
        wmts_ns = NS["wmts"]["wmts"]
        layers  = root.findall(f".//{{{wmts_ns}}}Layer")

    for layer in layers:
        id_el    = layer.find(f"{{{ows}}}Identifier") or layer.find("Identifier")
        title_el = layer.find(f"{{{ows}}}Title")      or layer.find("Title")
        bbox_el  = layer.find(f"{{{ows}}}WGS84BoundingBox") or layer.find("WGS84BoundingBox")

        if id_el is None:
            continue

        sub = {
            "name":  (id_el.text    or "").strip(),
            "title": (title_el.text if title_el is not None else "").strip(),
        }

        if bbox_el is not None:
            lower = bbox_el.find(f"{{{ows}}}LowerCorner") or bbox_el.find("LowerCorner")
            upper = bbox_el.find(f"{{{ows}}}UpperCorner") or bbox_el.find("UpperCorner")
            if lower is not None and upper is not None:
                try:
                    lon_min, lat_min = map(float, lower.text.split())
                    lon_max, lat_max = map(float, upper.text.split())
                    sub["bbox"] = [round(lon_min, 6), round(lat_min, 6),
                                   round(lon_max, 6), round(lat_max, 6)]
                    if resultado["bbox_real"] is None:
                        resultado["bbox_real"] = sub["bbox"]
                except (ValueError, AttributeError):
                    pass

        resultado["sublayers"].append(sub)

    return resultado


def parsear_wfs(root: ET.Element) -> dict:
    """
    Parsea GetCapabilities WFS (1.0, 1.1, 2.0).
    Extrae WGS84BoundingBox de cada FeatureType.
    """
    resultado = {"bbox_real": None, "sublayers": []}
    ows = NS["wfs"]["ows"]

    # WFS 2.0 usa OWS; WFS 1.x tiene estructura propia
    feature_types = (
        root.findall(f".//{{{ows}}}FeatureType")   or
        root.findall(".//FeatureType")
    )

    for ft in feature_types:
        name_el  = ft.find(f"{{{ows}}}Name")  or ft.find("Name")
        title_el = ft.find(f"{{{ows}}}Title") or ft.find("Title")
        bbox_el  = (ft.find(f"{{{ows}}}WGS84BoundingBox") or
                    ft.find("WGS84BoundingBox") or
                    ft.find("LatLongBoundingBox"))

        if name_el is None:
            continue

        sub = {
            "name":  (name_el.text  or "").strip(),
            "title": (title_el.text if title_el is not None else "").strip(),
        }

        if bbox_el is not None:
            lower = bbox_el.find(f"{{{ows}}}LowerCorner") or bbox_el.find("LowerCorner")
            upper = bbox_el.find(f"{{{ows}}}UpperCorner") or bbox_el.find("UpperCorner")
            if lower is not None and upper is not None:
                try:
                    lon_min, lat_min = map(float, lower.text.split())
                    lon_max, lat_max = map(float, upper.text.split())
                    sub["bbox"] = [round(lon_min, 6), round(lat_min, 6),
                                   round(lon_max, 6), round(lat_max, 6)]
                    if resultado["bbox_real"] is None:
                        resultado["bbox_real"] = sub["bbox"]
                except (ValueError, AttributeError):
                    pass
            else:
                # WFS 1.0 usa atributos directos en LatLongBoundingBox
                bbox = _bbox_a_lista(
                    bbox_el.get("minx"), bbox_el.get("miny"),
                    bbox_el.get("maxx"), bbox_el.get("maxy"),
                )
                if bbox:
                    sub["bbox"] = bbox
                    if resultado["bbox_real"] is None:
                        resultado["bbox_real"] = bbox

        resultado["sublayers"].append(sub)

    return resultado


def parsear_wcs(root: ET.Element) -> dict:
    """
    Parsea GetCapabilities WCS (1.0, 1.1, 2.0).
    Extrae bbox de cada CoverageOffering / CoverageSummary.
    """
    resultado = {"bbox_real": None, "sublayers": []}
    ows = NS["wcs"]["ows"]

    # WCS 2.0 → CoverageSummary; WCS 1.x → CoverageOffering
    coverages = (
        root.findall(".//CoverageOffering") or
        root.findall(f".//{{{ows}}}CoverageSummary") or
        root.findall(".//CoverageSummary")
    )

    for cov in coverages:
        name_el  = (cov.find("name") or cov.find("Name") or
                    cov.find(f"{{{ows}}}Identifier") or cov.find("Identifier"))
        label_el = (cov.find("label") or cov.find("Label") or
                    cov.find(f"{{{ows}}}Title") or cov.find("Title"))

        if name_el is None:
            continue

        sub = {
            "name":  (name_el.text  or "").strip(),
            "title": (label_el.text if label_el is not None else "").strip(),
        }

        # lonLatEnvelope (WCS 1.0) o WGS84BoundingBox (WCS 1.1+)
        env = (cov.find("lonLatEnvelope") or
               cov.find(f"{{{ows}}}WGS84BoundingBox") or
               cov.find("WGS84BoundingBox"))

        if env is not None:
            pos_els = env.findall("pos") or env.findall("gml:pos",
                      {"gml": "http://www.opengis.net/gml"})
            lower = env.find(f"{{{ows}}}LowerCorner") or env.find("LowerCorner")
            upper = env.find(f"{{{ows}}}UpperCorner") or env.find("UpperCorner")

            try:
                if lower is not None and upper is not None:
                    lon_min, lat_min = map(float, lower.text.split())
                    lon_max, lat_max = map(float, upper.text.split())
                elif len(pos_els) >= 2:
                    lon_min, lat_min = map(float, pos_els[0].text.split())
                    lon_max, lat_max = map(float, pos_els[1].text.split())
                else:
                    raise ValueError("sin coordenadas reconocibles")

                sub["bbox"] = [round(lon_min, 6), round(lat_min, 6),
                               round(lon_max, 6), round(lat_max, 6)]
                if resultado["bbox_real"] is None:
                    resultado["bbox_real"] = sub["bbox"]
            except (ValueError, AttributeError):
                pass

        resultado["sublayers"].append(sub)

    return resultado


def intentar_xyz_tilejson(url_base: str) -> dict:
    """
    Intenta obtener metadatos de un servicio XYZ buscando TileJSON
    en rutas estándar. Si no encuentra nada, devuelve estado no_soportado.
    """
    candidatos = [
        url_base.rstrip("/") + "/metadata.json",
        url_base.rstrip("/") + "/tilejson.json",
    ]

    for url in candidatos:
        try:
            resp = requests.get(url, timeout=TIMEOUT_SEGUNDOS,
                                headers={"User-Agent": "gis-app-catalogo-enricher/1.0"})
            if resp.status_code == 200:
                data  = resp.json()
                bbox  = data.get("bounds")   # [minLon, minLat, maxLon, maxLat]
                subs  = []
                for v in data.get("vector_layers", []):
                    subs.append({"name": v.get("id", ""), "title": v.get("description", "")})
                return {
                    "bbox_real":  bbox,
                    "sublayers":  subs,
                    "tilejson_url": url,
                }
        except Exception:
            continue

    return None   # indica que no se encontró nada


# ─────────────────────────────────────────────
# DESPACHADOR POR TIPO
# ─────────────────────────────────────────────

PARSERS = {
    "WMS":  parsear_wms,
    "WMTS": parsear_wmts,
    "WFS":  parsear_wfs,
    "WCS":  parsear_wcs,
}

def enriquecer_capa(capa: dict) -> dict:
    """
    Consulta el capabilities de la capa y devuelve el bloque _enriquecido.
    No modifica ningún campo existente de la capa.
    """
    tipo = (capa.get("tipo") or "").upper()
    hoy  = datetime.date.today().isoformat()

    base = {"fecha": hoy, "estado": None, "bbox_real": None, "sublayers": []}

    # — Tipos sin estándar de capabilities —
    if tipo in ("API", "DESCARGA"):
        base["estado"] = "tipo_no_soportado"
        base["nota"]   = f"El tipo '{tipo}' no tiene GetCapabilities estándar."
        return base

    # — XYZ: intento TileJSON —
    if tipo == "XYZ":
        url_base = (capa.get("url") or "").strip()
        resultado = intentar_xyz_tilejson(url_base) if url_base else None
        if resultado:
            base.update(resultado)
            base["estado"] = "ok"
        else:
            base["estado"] = "tipo_no_soportado"
            base["nota"]   = "XYZ sin TileJSON accesible. Sin bbox automático."
        return base

    # — Servicios OGC: WMS, WMTS, WFS, WCS —
    parser = PARSERS.get(tipo)
    if not parser:
        base["estado"] = "tipo_no_soportado"
        base["nota"]   = f"Tipo '{tipo}' no tiene parser implementado."
        return base

    url = construir_url_capabilities(capa)
    if not url:
        base["estado"] = "sin_capabilities"
        base["nota"]   = "No hay capabilities_url ni url base para construirla."
        return base

    root, estado_fetch = fetch_xml(url)

    if root is None:
        base["estado"] = estado_fetch
        return base

    try:
        resultado = parser(root)
        base.update(resultado)
        base["estado"] = "ok"
    except Exception as e:
        base["estado"] = f"xml_invalido: error en parser: {str(e)[:100]}"

    return base


# ─────────────────────────────────────────────
# EJECUCIÓN PRINCIPAL
# ─────────────────────────────────────────────

def main():
    print("═══════════════════════════════════════════════════════")
    print("  Enriquecimiento de catálogo desde GetCapabilities")
    print("═══════════════════════════════════════════════════════\n")

    # Archivo de entrada
    ruta_catalogo = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(ARCHIVO_CATALOGO)
    if not ruta_catalogo.exists():
        print(f"❌ Archivo no encontrado: {ruta_catalogo}")
        sys.exit(1)

    with open(ruta_catalogo, encoding="utf-8") as f:
        catalogo = json.load(f)

    print(f"📄 Capas en catálogo: {len(catalogo)}\n")

    # Contadores para el informe
    contadores = {"ok": 0, "error_red": 0, "sin_capabilities": 0,
                  "xml_invalido": 0, "tipo_no_soportado": 0}
    lineas_informe = []

    for i, capa in enumerate(catalogo):
        nombre = capa.get("title") or capa.get("id") or f"capa_{i}"
        tipo   = (capa.get("tipo") or "?").upper()
        print(f"  [{i+1:>3}/{len(catalogo)}] {tipo:<5} {nombre[:55]}", end=" ... ", flush=True)

        enriquecido = enriquecer_capa(capa)
        capa["_enriquecido"] = enriquecido

        estado = enriquecido["estado"].split(":")[0]   # toma solo la clave antes de ":"
        estado_clave = estado if estado in contadores else "error_red"
        contadores[estado_clave] = contadores.get(estado_clave, 0) + 1

        # Icono visual
        icono = {"ok": "✅", "error_red": "❌", "sin_capabilities": "⚠️",
                 "xml_invalido": "⚠️", "tipo_no_soportado": "—"}.get(estado, "?")
        sublayers_n = len(enriquecido.get("sublayers") or [])
        bbox_txt    = str(enriquecido.get("bbox_real")) if enriquecido.get("bbox_real") else "sin bbox"
        print(f"{icono}  {estado:<20} sublayers: {sublayers_n}  bbox: {bbox_txt}")

        lineas_informe.append(
            f"{icono} [{tipo}] {nombre}\n"
            f"    estado: {enriquecido['estado']}\n"
            f"    bbox:   {enriquecido.get('bbox_real')}\n"
            f"    subs:   {sublayers_n}\n"
        )

    # Escribir catálogo actualizado
    ruta_salida = ruta_catalogo.parent / "catalogo-capas-enriquecido.json"
    with open(ruta_salida, "w", encoding="utf-8") as f:
        json.dump(catalogo, f, ensure_ascii=False, indent=2)

    # Escribir informe
    ruta_informe = ruta_catalogo.parent / ARCHIVO_INFORME
    with open(ruta_informe, "w", encoding="utf-8") as f:
        f.write(f"Informe de enriquecimiento — {datetime.date.today()}\n")
        f.write("=" * 60 + "\n\n")
        f.write(f"Total capas:         {len(catalogo)}\n")
        for k, v in contadores.items():
            f.write(f"  {k:<22} {v}\n")
        f.write("\nDetalle por capa:\n" + "-" * 60 + "\n")
        f.write("\n".join(lineas_informe))

    # Resumen en consola
    print("\n" + "─" * 55)
    print(f"✅ ok:                 {contadores['ok']}")
    print(f"❌ error_red:          {contadores['error_red']}")
    print(f"⚠️  sin_capabilities:   {contadores['sin_capabilities']}")
    print(f"⚠️  xml_invalido:       {contadores['xml_invalido']}")
    print(f"—  tipo_no_soportado:  {contadores['tipo_no_soportado']}")
    print(f"\n📦 Catálogo actualizado: {ruta_catalogo}")
    print(f"📋 Informe generado:     {ruta_informe}")
    print("═══════════════════════════════════════════════════════\n")


if __name__ == "__main__":
    main()
