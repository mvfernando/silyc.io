---
name: AI cuts autonomous
description: Pipeline de cortes 100% AI — waveform + snap automático + decisão re-encode/copy por segmento
type: feature
---
# AI cuts autônoma

## Problema
Hoje só a *detecção* de fala é AI (WhisperX). O FFmpeg corta com heurística simples → desalinhamento áudio/vídeo (drift por keyframes, ataque das plosivas, PTS, padding assimétrico).

## Objetivo
A AI faz tudo sozinha, sem toggle na UI: detectar fala → analisar waveform → snap automático a frames → escolher re-encode vs stream-copy por segmento → cortar com precisão sub-frame.

## Componentes
- Waveform analysis (zero-crossing + envelope) para refinar word.start em ~20–80 ms antes do ataque das consoantes.
- Snap automático: t = round(t * fps) / fps antes do FFmpeg.
- Decisão por segmento: re-encode `libx264 -preset veryfast` quando o corte cai longe de keyframe; senão `-c copy`.
- Padding simétrico no vídeo igual ao do áudio (0.25s pre, 0.15s post) com fade de 20ms casado.
- Concat com `-fflags +genpts -avoid_negative_ts make_zero -reset_timestamps 1`.

## Métricas
- Lip-sync error: alvo < 40 ms RMS em 10 vídeos de validação.
- Sílabas cortadas (plosivas): < 1% dos cortes.
- Custo aceitável: +30% de tempo de processamento.

## Decisões pendentes
1. Waveform analysis no browser (AudioBuffer) ou server-side (Replicate)?
2. Re-encode parcial no FFmpeg.wasm ou exigir Shotstack/server-side?
3. Ativar sempre ou só no tier Pro?
