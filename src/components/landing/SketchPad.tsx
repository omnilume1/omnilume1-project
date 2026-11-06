'use client';

import { useRef, type PointerEvent } from 'react';
import styles from '@/app/landing.module.css';

// A canvas over the landing whiteboard: draw on it with the mouse, pen or a finger.
// Strokes stay until the page reloads. WhatElse holds the cycle while the pointer is here.
export default function SketchPad() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokeRef = useRef<{ id: number; x: number; y: number } | null>(null);

  const context = () => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    // Size the backing store on first use (and after a resize), keeping what is drawn.
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      const keep = canvas.width && canvas.height ? canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height) : null;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      if (keep) canvas.getContext('2d')?.putImageData(keep, 0, 0);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#c4b5fd';
    return ctx;
  };
  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = point(event);
    strokeRef.current = { id: event.pointerId, x, y };
    const ctx = context();
    if (!ctx) return;
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#c4b5fd';
    ctx.fill();
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const stroke = strokeRef.current;
    if (!stroke || stroke.id !== event.pointerId) return;
    const ctx = context();
    if (!ctx) return;
    // Coalesced events carry every sample since the last frame, so fast strokes stay smooth.
    const events = event.nativeEvent.getCoalescedEvents?.() ?? [];
    const rect = event.currentTarget.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo(stroke.x, stroke.y);
    for (const e of events.length ? events : [event.nativeEvent]) {
      stroke.x = e.clientX - rect.left;
      stroke.y = e.clientY - rect.top;
      ctx.lineTo(stroke.x, stroke.y);
    }
    ctx.stroke();
  };
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (strokeRef.current?.id === event.pointerId) strokeRef.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      className={styles.sketch}
      data-sketch
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
