import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { COLORS } from '../theme.js';

/**
 * Sweeps a bright window across text for a violet→white shimmer on the
 * currently-running step. Port of the reference ShimmerText.
 */
export function ShimmerText({ text, active = true }: { text: string; active?: boolean }) {
  const [pos, setPos] = useState(0);
  const windowSize = 4;

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      setPos((p) => (p + 1) % (text.length + windowSize * 2));
    }, 80);
    return () => clearInterval(t);
  }, [active, text.length]);

  if (!active) return <Text color={COLORS.white}>{text}</Text>;

  const chars = text.split('').map((ch, i) => {
    const windowStart = pos - windowSize;
    const dist = Math.abs(i - windowStart - windowSize / 2);
    let color: string;
    if (dist <= windowSize / 2) color = COLORS.white;
    else if (dist <= windowSize) color = COLORS.brand;
    else color = COLORS.dimmed;
    return (
      <Text key={i} color={color}>
        {ch}
      </Text>
    );
  });

  return <Text>{chars}</Text>;
}
