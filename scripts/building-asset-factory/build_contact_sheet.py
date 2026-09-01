#!/usr/bin/env python3
"""Render and compose a no-clobber fixed-camera Crackhouse LOD sheet."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import tempfile

from PIL import Image,ImageDraw,ImageFont


HERE=Path(__file__).resolve().parent
DEFAULT_BLENDER=Path.home()/".local/share/tarkovzero-tools/blender-4.5.13/blender"


def parse_item(value: str) -> tuple[str,Path]:
    if "=" not in value:raise argparse.ArgumentTypeError("items must use LABEL=/absolute/file.glb")
    label,raw=value.split("=",1);path=Path(raw).expanduser().resolve()
    if not label.strip() or not path.is_file() or path.suffix.lower()!=".glb":raise argparse.ArgumentTypeError(f"invalid item: {value}")
    return label.strip(),path


def parse_args() -> argparse.Namespace:
    parser=argparse.ArgumentParser();parser.add_argument("--blender",type=Path,default=DEFAULT_BLENDER);parser.add_argument("--title",required=True);parser.add_argument("--view",choices=("oblique","south","east"),default="oblique");parser.add_argument("--item",action="append",type=parse_item,required=True);parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args();args.blender=args.blender.expanduser().resolve();args.output=args.output.expanduser().resolve()
    if not args.blender.is_file():parser.error(f"Blender not found: {args.blender}")
    if not 2<=len(args.item)<=4:parser.error("contact sheet requires 2..4 items")
    if args.output.suffix.lower()!=".png" or args.output.exists() or not args.output.parent.is_dir():parser.error("--output must be a new .png in an existing directory")
    return args


def main() -> None:
    args=parse_args()
    with tempfile.TemporaryDirectory(prefix="tarkovzero-crackhouse-preview-") as raw:
        temp=Path(raw);renders=[]
        for index,(label,glb) in enumerate(args.item):
            png=temp/f"preview-{index}.png"
            command=[str(args.blender),"--background","--factory-startup","--disable-autoexec","--python-exit-code","1","--python",str(HERE/"render_crackhouse_preview.py"),"--","--glb",str(glb),"--output",str(png),"--view",args.view]
            completed=subprocess.run(command,check=False,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            if completed.returncode!=0:raise RuntimeError(f"preview failed for {glb}:\n{completed.stdout[-6000:]}")
            renders.append((label,Image.open(png).convert("RGB")))
        cell_w,cell_h=renders[0][1].size;columns=len(renders);title_h,label_h,footer_h=66,42,38
        sheet=Image.new("RGB",(cell_w*columns,title_h+cell_h+label_h+footer_h),(18,21,20));draw=ImageDraw.Draw(sheet)
        draw.text((22,18),args.title,fill=(226,229,220),font=ImageFont.load_default(size=24))
        for index,(label,render) in enumerate(renders):
            x=index*cell_w;sheet.paste(render,(x,title_h));draw.rectangle((x,title_h,x+cell_w-1,title_h+cell_h+label_h-1),outline=(67,73,68),width=2);draw.text((x+18,title_h+cell_h+11),label,fill=(222,203,151),font=ImageFont.load_default(size=18))
        draw.text((18,title_h+cell_h+label_h+9),"One fixed camera/light rig · canonical base plane, not terrain evidence · openings/interior remain hypotheses",fill=(146,151,144),font=ImageFont.load_default(size=13))
        descriptor,temp_name=tempfile.mkstemp(prefix=f".{args.output.stem}.",suffix=".png",dir=args.output.parent);os.close(descriptor);temporary=Path(temp_name)
        try:
            sheet.save(temporary,format="PNG",optimize=False);os.link(temporary,args.output)
        finally:temporary.unlink(missing_ok=True)
        print(args.output)


if __name__=="__main__":main()
