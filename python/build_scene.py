"""dsh-blender-bridge 驱动脚本

用法：
  blender.exe --background --factory-startup --python build_scene.py -- <spec.json> <out.blend> <out.png>

spec.json 结构见 README。脚本最后会打印一行：
  RESULT {"ok":true,"objects":3,...}
供宿主插件解析。
"""
import bpy
import os
import sys
import json
import math
import traceback
from mathutils import Vector


def hex_to_rgba(value, alpha=1.0):
    if not isinstance(value, str):
        return (0.8, 0.8, 0.8, alpha)
    s = value.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    try:
        r, g, b = (int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
        return (r, g, b, alpha)
    except Exception:
        return (0.8, 0.8, 0.8, alpha)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def make_material(name, color_hex, metallic=0.0, roughness=0.5):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    r, g, b, a = hex_to_rgba(color_hex)
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (
            srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), a)
        bsdf.inputs["Metallic"].default_value = float(metallic)
        bsdf.inputs["Roughness"].default_value = float(roughness)
    return mat


PRIMITIVES = {
    "cube": lambda: bpy.ops.mesh.primitive_cube_add(),
    "sphere": lambda: bpy.ops.mesh.primitive_uv_sphere_add(),
    "cylinder": lambda: bpy.ops.mesh.primitive_cylinder_add(),
    "cone": lambda: bpy.ops.mesh.primitive_cone_add(),
    "torus": lambda: bpy.ops.mesh.primitive_torus_add(),
    "plane": lambda: bpy.ops.mesh.primitive_plane_add(),
    "circle": lambda: bpy.ops.mesh.primitive_circle_add(),
}


def build_object(obj):
    kind = (obj.get("type") or "cube").lower()
    name = obj.get("name") or kind
    loc = Vector(obj.get("location", (0, 0, 0)))
    scale = Vector(obj.get("scale", (1, 1, 1)))
    rotation = obj.get("rotation", (0, 0, 0))
    segments = int(obj.get("segments", 32))
    radius = float(obj.get("radius", 1.0))

    fn = PRIMITIVES.get(kind, PRIMITIVES["cube"])
    if kind in ("sphere",):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=max(4, segments // 2), radius=radius, location=loc)
    elif kind in ("cylinder", "cone"):
        bpy.ops.mesh.primitive_cylinder_add(vertices=segments, radius=radius, depth=2.0, location=loc) if kind == "cylinder" \
            else bpy.ops.mesh.primitive_cone_add(vertices=segments, radius1=radius, depth=2.0, location=loc)
    else:
        fn()
        if kind != "plane" and kind != "circle":
            bpy.context.active_object.location = loc

    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    o.rotation_euler = rotation

    color = obj.get("color")
    if color:
        mat = make_material(name + "_mat", color, obj.get("metallic", 0.0), obj.get("roughness", 0.5))
        o.data.materials.append(mat)
    return o


def scene_bounds(objects):
    pts = []
    for o in objects:
        for c in o.bound_box:
            pts.append(o.matrix_world @ Vector(c))
    if not pts:
        return Vector((0, 0, 1)), 4.0
    xs = [p.x for p in pts]; ys = [p.y for p in pts]; zs = [p.z for p in pts]
    center = Vector(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2))
    radius = max(1e-3, max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)))
    return center, radius


def aim(obj, target):
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def main():
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    if len(args) < 3:
        print('RESULT {"ok":false,"error":"bad args"}')
        return
    spec_path, out_blend, out_png = args[0], args[1], args[2]

    with open(spec_path, "r", encoding="utf-8-sig") as f:
        spec = json.load(f)

    bpy.ops.wm.read_factory_settings(use_empty=True)

    built = []
    for obj in spec.get("objects", []):
        built.append(build_object(obj))

    # 地面
    if spec.get("ground", False):
        bpy.ops.mesh.primitive_plane_add(size=max(6.0, scene_bounds(built)[1] * 3.2), location=(0, 0, -0.001))
        g = bpy.context.active_object
        g.name = "Ground"
        g.data.materials.append(make_material("ground_mat", spec.get("groundColor", "#2a2a30"), 0.0, 0.9))

    # 世界背景
    world = bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = hex_to_rgba(spec.get("background", "#101014"))
        bg.inputs[1].default_value = float(spec.get("worldStrength", 1.2))

    center, radius = scene_bounds(built)

    # 灯光：主光 + 补光 + 轮廓光
    def add_light(kind, loc, energy, size=5.0):
        if kind == "SUN":
            bpy.ops.object.light_add(type="SUN", location=loc)
            L = bpy.context.active_object
            L.data.energy = energy
            aim(L, center)
        else:
            bpy.ops.object.light_add(type="AREA", location=loc)
            L = bpy.context.active_object
            L.data.energy = energy
            L.data.size = size
            aim(L, center)
        return L

    d = radius * 3.0
    add_light("AREA", center + Vector((d, -d, d * 1.1)), 2000 * radius, radius * 4)
    add_light("AREA", center + Vector((-d, -d * 0.4, d * 0.5)), 700 * radius, radius * 4)
    add_light("AREA", center + Vector((0, d, d * 0.8)), 900 * radius, radius * 3)

    # 相机
    cam_spec = spec.get("camera") or {}
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    if cam_spec.get("location"):
        cam.location = Vector(cam_spec["location"])
        target = Vector(cam_spec.get("look_at", center))
    else:
        bpy.context.view_layer.update()
        fov = cam.data.angle
        dist = (radius * 0.5) / math.tan(fov / 2.0) * float(cam_spec.get("fit", 1.15))
        direction = Vector((0.62, -1.0, 0.52)).normalized()
        cam.location = center + direction * dist
        target = center
    aim(cam, target)
    cam.data.lens = float(cam_spec.get("lens", 50))
    bpy.context.scene.camera = cam

    # 渲染设置
    sc = bpy.context.scene
    engine = spec.get("engine", "CYCLES")
    sc.render.engine = engine if engine in ("CYCLES", "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH") else "CYCLES"
    if sc.render.engine == "CYCLES":
        sc.cycles.device = "CPU"
        sc.cycles.samples = int(spec.get("samples", 32))
        sc.cycles.use_denoising = True
    sc.render.resolution_x = int(spec.get("width", 720))
    sc.render.resolution_y = int(spec.get("height", 720))
    sc.render.resolution_percentage = 100
    sc.render.filepath = out_png
    sc.render.image_settings.file_format = "PNG"
    sc.view_settings.view_transform = "Filmic" if "Filmic" in [v.name for v in sc.view_settings.bl_rna.properties["view_transform"].enum_items] else sc.view_settings.view_transform

    bpy.ops.wm.save_as_mainfile(filepath=out_blend)

    # 导出 glTF，供面板里的 3D 视口直接加载（可拖拽环绕 / 滚轮缩放）
    out_glb = os.path.join(os.path.dirname(out_blend), "scene.glb")
    try:
        bpy.ops.export_scene.gltf(
            filepath=out_glb,
            export_format="GLB",
            export_apply=True,
            use_selection=False,
            export_yup=True,
        )
    except Exception as exc:
        print("GLTF_EXPORT_FAILED " + str(exc))
        out_glb = ""
    bpy.ops.render.render(write_still=True)

    print("RESULT " + json.dumps({
        "ok": True,
        "objects": len(built),
        "names": [o.name for o in built],
        "center": list(center),
        "radius": radius,
        "blend": out_blend,
        "preview": out_png,
          "glb": out_glb,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("RESULT " + json.dumps({"ok": False, "error": str(exc), "trace": traceback.format_exc()[-1500:]}, ensure_ascii=False))
        sys.exit(3)
