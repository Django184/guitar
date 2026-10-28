#!/usr/bin/env python3
"""
Banque de sons SF2 → SF3 préparée pour le synthétiseur d'alphaTab 1.8.4 (portage de TinySoundFont).

Format SF3 (celui de MuseScore, lu par alphaTab) : chaque échantillon du bloc smpl devient un
flux Ogg Vorbis ; dans shdr, début et fin sont les positions en octets de ce flux, les points de
boucle sont relatifs au début de l'échantillon, et le type porte le drapeau 0x10.

Ce synthétiseur s'écarte de la norme SoundFont ; pour qu'il joue la banque comme FluidSynth (le
lecteur pour lequel GeneralUser GS est réglée), le script :
- « cuit » les décalages d'adresse : alphaTab ignore en SF3 le décalage de début d'une zone
  (startAddrsOffset, utilisé par les cordes ou la guitare acier de GeneralUser GS), et additionne
  ceux de la zone globale et de la zone au lieu de les remplacer. Chaque zone pointe donc vers un
  échantillon encodé à partir de son début effectif, avec ses points de boucle effectifs ;
- écrit dans chaque zone l'atténuation et l'accord (qu'alphaTab additionne aussi), l'atténuation
  multipliée par 0,4 comme le font FluidSynth et les cartes E-mu / Sound Blaster ;
- inscrit dans les générateurs l'effet des modulateurs de vélocité et de hauteur (qu'alphaTab
  ignore), calculé pour la nuance « f » d'alphaTab (vélocité 95) et la note centrale de la zone.
La banque produite est donc destinée à alphaTab (un lecteur conforme appliquerait deux fois le
facteur 0,4 et les modulateurs, conservés dans le fichier).

Réglages de compression recommandés par l'auteur de GeneralUser GS (sf3convert -q 0.8 -a -1) :
qualité Vorbis 0,8 (8 sur l'échelle de FFmpeg) et −1 dB, pour éviter la saturation qu'apporte la
compression. alphaTab ne joue que les échantillons mono : le script refuse les autres.

Utilisation : python3 scripts/sf2-to-sf3.py GeneralUser-GS.sf2 public/sons/generaluser-gs-2.0.3.sf3
Contrôle : --sans-compression écrit la même banque en SF2 (mêmes découpes, PCM 16 bits).
Demande FFmpeg avec libvorbis. Le résultat est reproductible à l'octet près.
"""
import argparse
import math
import os
import struct
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

SHDR = struct.Struct('<20sIIIIIBbHH')
# Silence ajouté après chaque échantillon avant l'encodage : selon l'encodeur et le décodeur, la
# fin du flux Vorbis peut être rognée d'un bloc ; le décodage couvre ainsi toujours l'original
# (les boucles restent dans l'échantillon). Le début, lui, est exact.
PAD = 2048


def chunks(b, start, end):
    at = start
    while at + 8 <= end:
        cid = b[at:at + 4]
        size = struct.unpack_from('<I', b, at + 4)[0]
        yield cid, b[at + 8:at + 8 + size]
        at += 8 + size + (size & 1)


def chunk(cid, data):
    # Taille toujours paire, sans octet de remplissage : l'analyseur RIFF d'alphaTab ne saute pas
    # ce remplissage et perdrait la suite du fichier (les en-têtes, après les échantillons).
    if len(data) & 1:
        data += b'\0'
    return cid + struct.pack('<I', len(data)) + data


def riff_list(kind, parts):
    return chunk(b'LIST', kind + b''.join(parts))


def records(data, fmt):
    rec = struct.Struct(fmt)
    return [list(rec.unpack_from(data, i)) for i in range(0, len(data), rec.size)]


def pack(records_, fmt):
    rec = struct.Struct(fmt)
    return b''.join(rec.pack(*r) for r in records_)


# Générateurs d'adresse d'une zone d'instrument : (fin, grossier × 32 768) pour le début de
# l'échantillon et les deux points de boucle.
ADDRESS = {'start': (0, 4), 'loop_start': (2, 45), 'loop_end': (3, 50)}
ADDRESS_OPS = {op for pair in ADDRESS.values() for op in pair}
# Générateurs qu'alphaTab additionne entre zone globale et zone (la norme : la zone remplace) :
# atténuation, accord grossier et fin. Leur valeur effective est inscrite dans chaque zone.
ADDITIVE = (48, 51, 52)
ATTENUATION = 48
KEY_RANGE, VEL_RANGE = 43, 44
# Valeurs par défaut (norme SF2) des générateurs que les modulateurs peuvent viser et qu'alphaTab
# applique ; les autres cibles (atténuation, résonance, réverbération, chorus) sont laissées.
GEN_DEFAULTS = {
    5: 0, 6: 0, 7: 0, 8: 13500, 10: 0, 11: 0, 13: 0, 17: 0, 21: -12000, 22: 0, 23: -12000, 24: 0,
    25: -12000, 26: -12000, 27: -12000, 28: -12000, 29: 0, 30: -12000, 31: 0, 32: 0,
    33: -12000, 34: -12000, 35: -12000, 36: -12000, 37: 0, 38: -12000, 39: 0, 40: 0, 51: 0, 52: 0,
}
LIMITS = {8: (1500, 13500)}


def source_value(src, velocity, key):
    """Valeur (0 à 1, ou −1 à 1) d'une source de modulateur ; None si elle n'est pas connue d'avance."""
    if src == 0:
        return 1.0
    index, cc = src & 0x7F, src >> 7 & 1
    if cc or index not in (2, 3):
        return None
    x = (velocity if index == 2 else key) / 128
    if src >> 8 & 1:
        x = 1 - x
    curve = src >> 10
    if curve == 1:
        y = min(1.0, -20 / 96 * math.log10(max((1 - x) ** 2, 1e-12)))
    elif curve == 2:
        y = 1 - min(1.0, -20 / 96 * math.log10(max(x ** 2, 1e-12)))
    elif curve == 3:
        y = 1.0 if x >= 0.5 else 0.0
    else:
        y = x
    return 2 * y - 1 if src >> 9 & 1 else y


def modulation(mods, velocity, key):
    """Effet des modulateurs calculables d'avance (vélocité, hauteur de note), par générateur."""
    out = {}
    for src, dest, amount, amt_src, trans in mods:
        if dest not in GEN_DEFAULTS:
            continue
        a, b = source_value(src, velocity, key), source_value(amt_src, velocity, key)
        if a is None or b is None:
            continue
        value = amount * a * b
        out[dest] = out.get(dest, 0) + (abs(value) if trans == 2 else value)
    return out


def resolve(global_mods, local_mods):
    """Modulateurs d'une zone : ceux de la zone globale, remplacés par ceux de même identité."""
    ident = lambda m: (m[0], m[1], m[3], m[4])  # noqa: E731
    table = {ident(m): m for m in global_mods}
    table.update({ident(m): m for m in local_mods})
    return list(table.values())


def span(gens, defaults, op):
    value = dict((g[0], g[1]) for g in gens).get(op, defaults.get(op))
    return (0, 127) if value is None else (value & 0xFF, (value >> 8) & 0xFF)


def flatten(zones, mods, last_op, attenuation_scale, base, velocity):
    """
    Zones d'un preset ou d'un instrument (générateurs [op, valeur], modulateurs) préparées pour
    alphaTab, qui ignore les modulateurs et additionne certains générateurs :
    - l'effet des modulateurs de vélocité et de hauteur (ouverture du filtre, enveloppes…) est
      calculé pour `velocity` (ramenée dans la plage de la zone) et pour la note centrale de la zone,
      et inscrit dans les générateurs ;
    - les générateurs additifs prennent dans chaque zone leur valeur effective et quittent la zone
      globale ;
    - l'atténuation est multipliée par `attenuation_scale` (0,4 : comme FluidSynth et les cartes
      E-mu / Sound Blaster, pour lesquels les banques sont réglées ; alphaTab l'applique telle quelle).
    `base` : valeur d'un générateur absent (norme pour un instrument, 0 pour un preset).
    """
    is_global = lambda gens: not gens or gens[-1][0] != last_op  # noqa: E731
    has_global = bool(zones) and is_global(zones[0])
    defaults = {op: amt for op, amt in zones[0]} if has_global else {}
    global_mods = mods[0] if has_global else []
    out = []
    for gens, zone_mods in zip(zones, mods):
        if is_global(gens):
            out.append([g for g in gens if g[0] not in ADDITIVE])
            continue
        own = {op: amt for op, amt in gens}
        lo, hi = span(gens, defaults, VEL_RANGE)
        key_lo, key_hi = span(gens, defaults, KEY_RANGE)
        delta = modulation(resolve(global_mods, zone_mods), min(max(velocity, lo), hi), (key_lo + key_hi) / 2)
        changed = list(ADDITIVE) + [op for op in delta if op not in ADDITIVE]
        gens = [g for g in gens if g[0] not in changed]
        for op in changed:
            value = own.get(op, defaults.get(op))
            if op in delta:
                value = (base.get(op, 0) if value is None else value) + delta[op]
            if value is None:
                continue
            if op == ATTENUATION:
                value *= attenuation_scale
            low, high = LIMITS.get(op, (-32768, 32767))
            value = min(max(round(value), low), high)
            if value or op not in ADDITIVE:
                gens.insert(len(gens) - 1, [op, value])
        out.append(gens)
    return out


def flatten_presets(phdrs, pbags, pgens, pmods, attenuation_scale, velocity):
    """Presets : même préparation (la zone se termine par le générateur d'instrument, 41)."""
    new_bags, new_gens = [], []
    for pi in range(len(phdrs) - 1):
        first, last = phdrs[pi][3], phdrs[pi + 1][3]
        zones = [[list(g) for g in pgens[pbags[bi][0]:pbags[bi + 1][0]]] for bi in range(first, last)]
        mods = [pmods[pbags[bi][1]:pbags[bi + 1][1]] for bi in range(first, last)]
        for k, gens in enumerate(flatten(zones, mods, 41, attenuation_scale, {}, velocity)):
            new_bags.append([len(new_gens), pbags[first + k][1]])
            new_gens.extend(gens)
    new_bags.append([len(new_gens), pbags[-1][1]])
    new_gens.append(list(pgens[-1]))
    return new_bags, new_gens


def bake_offsets(insts, ibags, igens, imods, nsamples, attenuation_scale, velocity):
    """
    Décalages d'adresse des zones (début, points de boucle) inscrits dans les échantillons.

    alphaTab ignore en SF3 le décalage de début, et additionne ceux de la zone globale et de la
    zone, là où la norme SF2 veut que la zone remplace la valeur globale. Chaque zone reçoit donc
    un échantillon découpé à son début, avec ses points de boucle effectifs (selon la norme), et
    plus aucun générateur d'adresse : alphaTab et les autres lecteurs jouent la même chose.
    Renvoie les nouvelles listes ibag / igen, et les échantillons à produire :
    (indice d'origine, début, décalage du début de boucle, décalage de la fin de boucle).
    """
    views = [(i, 0, 0, 0) for i in range(nsamples)]
    view_of = {v: i for i, v in enumerate(views)}
    new_bags, new_gens = [], []
    for ii in range(len(insts) - 1):
        first, last = insts[ii][1], insts[ii + 1][1]
        zones = [[list(g) for g in igens[ibags[bi][0]:ibags[bi + 1][0]]] for bi in range(first, last)]
        is_global = lambda gens: not gens or gens[-1][0] != 53  # noqa: E731
        defaults = {op: amt for op, amt in zones[0]} if zones and is_global(zones[0]) else {}
        mods = [imods[ibags[bi][1]:ibags[bi + 1][1]] for bi in range(first, last)]
        zones = flatten(zones, mods, 53, attenuation_scale, GEN_DEFAULTS, velocity)
        for k, gens in enumerate(zones):
            if not is_global(gens):
                own = {op: amt for op, amt in gens}
                value = {
                    name: own.get(fine, defaults.get(fine, 0)) + own.get(coarse, defaults.get(coarse, 0)) * 32768
                    for name, (fine, coarse) in ADDRESS.items()
                }
                key = (gens[-1][1] & 0xFFFF, max(value['start'], 0), value['loop_start'], value['loop_end'])
                if key not in view_of:
                    view_of[key] = len(views)
                    views.append(key)
                gens[-1][1] = view_of[key]
            gens = [g for g in gens if g[0] not in ADDRESS_OPS]
            new_bags.append([len(new_gens), ibags[first + k][1]])
            new_gens.extend(gens)
    new_bags.append([len(new_gens), ibags[-1][1]])
    new_gens.append(list(igens[-1]))
    # Échantillons que plus aucune zone n'utilise (remplacés par leurs copies découpées) : retirés.
    used = sorted({g[1] & 0xFFFF for g in new_gens[:-1] if g[0] == 53})
    renumber = {old: new for new, old in enumerate(used)}
    for g in new_gens[:-1]:
        if g[0] == 53:
            g[1] = renumber[g[1] & 0xFFFF]
    return new_bags, new_gens, [views[i] for i in used]


def encode(pcm, rate, quality, gain_db):
    """Flux Ogg Vorbis d'un échantillon mono 16 bits."""
    cmd = [
        'ffmpeg', '-v', 'error', '-f', 's16le', '-ar', str(rate), '-ac', '1', '-i', 'pipe:0',
        '-af', f'volume={gain_db}dB', '-c:a', 'libvorbis', '-q:a', str(quality * 10),
        '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-f', 'ogg', 'pipe:1',
    ]
    return subprocess.run(cmd, input=pcm + bytes(PAD * 2), stdout=subprocess.PIPE, check=True).stdout


def convert(src, dst, quality, gain_db, comment, lossless=False, attenuation_scale=0.4, velocity=95):
    b = open(src, 'rb').read()
    if b[:4] != b'RIFF' or b[8:12] != b'sfbk':
        sys.exit(f'{src} : pas une banque SoundFont')
    info, smpl, pdta = [], None, []
    for cid, data in chunks(b, 12, len(b)):
        if cid != b'LIST':
            continue
        kind = data[:4]
        subs = list(chunks(data, 4, len(data)))
        if kind == b'INFO':
            info = subs
        elif kind == b'sdta':
            smpl = next(d for c, d in subs if c == b'smpl')
        elif kind == b'pdta':
            pdta = subs
    shdr_data = next(d for c, d in pdta if c == b'shdr')
    headers = [list(SHDR.unpack_from(shdr_data, i)) for i in range(0, len(shdr_data), SHDR.size)]
    samples = headers[:-1]
    for h in samples:
        if h[9] != 1:
            sys.exit(f'échantillon non mono ({h[0].rstrip(bytes(1)).decode("latin1")}, type {h[9]}) : alphaTab ne le jouerait pas')

    pdta_map = dict(pdta)
    insts = records(pdta_map[b'inst'], '<20sH')
    ibags = records(pdta_map[b'ibag'], '<HH')
    igens = records(pdta_map[b'igen'], '<Hh')
    imods = records(pdta_map[b'imod'], '<HHhHH')
    new_bags, new_gens, views = bake_offsets(insts, ibags, igens, imods, len(samples), attenuation_scale, velocity)
    phdrs = records(pdta_map[b'phdr'], '<20sHHHIII')
    pbags = records(pdta_map[b'pbag'], '<HH')
    pgens = records(pdta_map[b'pgen'], '<Hh')
    pmods = records(pdta_map[b'pmod'], '<HHhHH')
    new_pbags, new_pgens = flatten_presets(phdrs, pbags, pgens, pmods, attenuation_scale, velocity)

    def cut(view):
        index, offset, _, _ = view
        h = samples[index]
        return min(h[1] + offset, h[2] - 1), h

    def job(view):
        start, h = cut(view)
        pcm = smpl[start * 2:h[2] * 2]
        if lossless:
            # Contrôle : mêmes découpes, en SF2 (PCM 16 bits), même gain.
            g = 10 ** (gain_db / 20)
            return b''.join(struct.pack('<h', max(-32768, min(32767, round(v * g)))) for (v,) in struct.iter_unpack('<h', pcm))
        return encode(pcm, h[5], quality, gain_db)

    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        streams = list(pool.map(job, views))

    data = bytearray()
    out_headers = []
    for view, ogg in zip(views, streams):
        start, h = cut(view)
        name, _, end, loop_start, loop_end, rate, pitch, correction, link, kind = h
        if lossless:
            first = len(data) // 2
            data += ogg + bytes(46 * 2)
            length = end - start
            out_headers.append([
                name, first, first + length,
                first + min(max(loop_start + view[2] - start, 0), length), first + min(max(loop_end + view[3] - start, 0), length),
                rate, pitch, correction, link, kind,
            ])
            continue
        offset = len(data)
        data += ogg
        # Boucle relative au début de l'échantillon (en points), décalages de la zone compris,
        # bornée à l'échantillon.
        length = end - start
        out_headers.append([
            name, offset, len(data),
            min(max(loop_start + view[2] - start, 0), length), min(max(loop_end + view[3] - start, 0), length),
            rate, pitch, correction, link, kind | 0x10,
        ])
    if not lossless:
        data += bytes(46 * 2)
    terminal = list(headers[-1])
    terminal[1:5] = [len(data) // 2 if lossless else len(data)] * 4
    shdr_new = pack(out_headers + [terminal], '<20sIIIIIBbHH')
    replaced = {
        b'shdr': shdr_new,
        b'ibag': pack(new_bags, '<HH'),
        b'igen': pack(new_gens, '<Hh'),
        b'pbag': pack(new_pbags, '<HH'),
        b'pgen': pack(new_pgens, '<Hh'),
    }

    info_out = []
    for cid, d in info:
        if cid == b'ifil':
            d = struct.pack('<HH', 2 if lossless else 3, 1)
        elif cid == b'ICMT':
            continue
        info_out.append(chunk(cid, d))
    old_comment = next((d for c, d in info if c == b'ICMT'), b'').rstrip(b'\0')
    note = (old_comment + b'\n\n' if old_comment else b'') + comment.encode('latin1', 'replace') + b'\0'
    info_out.append(chunk(b'ICMT', note))

    body = (
        b'sfbk'
        + riff_list(b'INFO', info_out)
        + riff_list(b'sdta', [chunk(b'smpl', bytes(data))])
        + riff_list(b'pdta', [chunk(c, replaced.get(c, d)) for c, d in pdta])
    )
    with open(dst, 'wb') as f:
        f.write(chunk(b'RIFF', body))
    print(
        f'{src} ({len(b) / 1e6:.1f} Mo) → {dst} ({(len(body) + 8) / 1e6:.1f} Mo), '
        f'{len(views)} échantillons (dont copies découpées pour les décalages de début ; {len(samples)} au départ)'
    )


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--quality', type=float, default=0.8, help='qualité Vorbis, de 0 à 1 (défaut 0,8)')
    ap.add_argument('--gain', type=float, default=-1.0, help='gain appliqué aux échantillons, en dB (défaut −1)')
    ap.add_argument('--sans-compression', action='store_true', help='contrôle : mêmes découpes, en SF2 non compressé')
    ap.add_argument('--facteur-attenuation', type=float, default=0.4, help='facteur appliqué aux atténuations (défaut 0,4, comme FluidSynth)')
    ap.add_argument('--velocite', type=int, default=95, help='vélocité de référence des modulateurs (défaut 95 : nuance « f » d\'alphaTab)')
    args = ap.parse_args()
    convert(
        args.src,
        args.dst,
        args.quality,
        args.gain,
        f'Adapted for the alphaTab synthesizer by Pratique Guitare: Ogg Vorbis q{args.quality}, {args.gain:+g} dB; '
        f'sample offsets baked; attenuation x{args.facteur_attenuation:g}; velocity/key modulators baked at velocity {args.velocite}.',
        lossless=args.sans_compression,
        attenuation_scale=args.facteur_attenuation,
        velocity=args.velocite,
    )
