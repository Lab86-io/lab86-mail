'use client';

import { motion, useAnimation } from 'motion/react';
import type React from 'react';
import type { HTMLAttributes } from 'react';
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { cn } from '@/lib/utils';

export interface FolderIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface FolderIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const FolderIcon = forwardRef<FolderIconHandle, FolderIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
    const controls = useAnimation();
    const isControlledRef = useRef(false);

    useImperativeHandle(ref, () => {
      isControlledRef.current = true;
      return {
        startAnimation: () => controls.start('animate'),
        stopAnimation: () => controls.start('normal'),
      };
    }, [controls]);

    const handleMouseEnter = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) onMouseEnter?.(event);
        else controls.start('animate');
      },
      [controls, onMouseEnter],
    );
    const handleMouseLeave = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) onMouseLeave?.(event);
        else controls.start('normal');
      },
      [controls, onMouseLeave],
    );

    return (
      <div
        className={cn(className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...props}
      >
        <motion.svg
          animate={controls}
          fill="none"
          height={size}
          initial="normal"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          variants={{
            normal: { scale: 1, rotate: 0 },
            animate: {
              scale: [1, 1.06, 1],
              rotate: [0, -2, 0],
              transition: { duration: 0.45, ease: 'easeOut' },
            },
          }}
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M3 7V6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v1" />
          <motion.path
            d="M3.5 9h17a1 1 0 0 1 .97 1.24l-2 8A2 2 0 0 1 17.53 20H6.47a2 2 0 0 1-1.94-1.76l-2-8A1 1 0 0 1 3.5 9Z"
            variants={{
              normal: { y: 0 },
              animate: { y: [0, -0.75, 0], transition: { duration: 0.45 } },
            }}
          />
        </motion.svg>
      </div>
    );
  },
);

FolderIcon.displayName = 'FolderIcon';

export { FolderIcon };
