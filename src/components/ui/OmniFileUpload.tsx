'use client';

import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { OmniIcon } from '@/components/ui/OmniIcon';

interface OmniFileUploadProps {
  onFilesSelected: (files: File[]) => void;
  accept?: string;
  disabled?: boolean;
  multiple?: boolean;
  label?: string;
  helper?: string;
}

export default function OmniFileUpload({
  onFilesSelected,
  accept,
  disabled = false,
  multiple = true,
  label = 'Drop files here or browse',
  helper = 'Private room storage - validated before upload',
}: OmniFileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  function selectFiles(files: FileList | null) {
    if (!files || files.length === 0 || disabled) return;
    onFilesSelected(Array.from(files));
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    selectFiles(event.target.files);
    event.target.value = '';
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    selectFiles(event.dataTransfer.files);
  }

  return (
    <div
      className={`omni-file-upload ${isDragging ? 'is-dragging' : ''} ${disabled ? 'is-disabled' : ''}`}
      onDragEnter={(event) => { event.preventDefault(); if (!disabled) setIsDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setIsDragging(false); }}
      onDrop={handleDrop}
    >
      <input ref={inputRef} type="file" className="sr-only" accept={accept} multiple={multiple} onChange={handleInput} disabled={disabled} />
      <button type="button" className="omni-file-upload-button" onClick={() => inputRef.current?.click()} disabled={disabled}>
        <span className="omni-file-upload-icon"><OmniIcon name="file" size={19} /></span>
        <span><strong>{label}</strong><small>{helper}</small></span>
        <OmniIcon name="arrow" size={16} />
      </button>
    </div>
  );
}
