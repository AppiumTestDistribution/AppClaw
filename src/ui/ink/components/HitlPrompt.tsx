import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { COLORS, symbols } from '../theme.js';

interface HitlPromptProps {
  type: string;
  question: string;
  options?: string[];
  onSubmit: (answer: string) => void;
}

/**
 * In-Ink human-in-the-loop prompt. Ink owns raw-mode stdin during a run, so
 * OTP / CAPTCHA / choice / confirmation input is captured here instead of via
 * Node readline (which would fight Ink for the terminal).
 */
export function HitlPrompt({ type, question, options, onSubmit }: HitlPromptProps) {
  const [value, setValue] = useState('');

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      <Box>
        <Text color={COLORS.cyan}>? </Text>
        <Text color={COLORS.cyan}>[{type.toUpperCase()}] </Text>
        <Text>{question}</Text>
      </Box>
      {options?.map((opt, i) => (
        <Text key={i} color={COLORS.dimmed}>
          {'   '}
          {i + 1}. {opt}
        </Text>
      ))}
      <Box>
        <Text color={COLORS.brand}>{symbols.prompt} </Text>
        <TextInput value={value} onChange={setValue} onSubmit={onSubmit} />
      </Box>
    </Box>
  );
}
