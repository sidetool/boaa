import { forwardRef } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';

/** 번역 icon set in real type: 文 and A as font glyphs, sized and placed like a lucide icon. */
export const TranslateIcon = forwardRef<SVGSVGElement, LucideProps>(function TranslateIcon(
  { size = 24, color = 'currentColor', strokeWidth: _strokeWidth, absoluteStrokeWidth: _absolute, ...rest },
  ref,
) {
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      fontFamily="inherit"
      fontWeight={700}
      {...rest}
    >
      <text x="0" y="12" fontSize="13">
        文
      </text>
      <text x="12.5" y="23.5" fontSize="14">
        A
      </text>
    </svg>
  );
}) as LucideIcon;
