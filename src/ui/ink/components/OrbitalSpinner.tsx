import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { COLORS } from '../theme.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Braille dot spinner. Shows a solid ● when inactive. */
export function OrbitalSpinner({ active = true }: { active?: boolean }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, [active]);

  return <Text color={COLORS.brand}>{active ? FRAMES[frame] : '●'}</Text>;
}
