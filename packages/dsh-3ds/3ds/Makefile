#---------------------------------------------------------------------------------
.SUFFIXES:
#---------------------------------------------------------------------------------
ifeq ($(strip $(DEVKITARM)),)
$(error "Please set DEVKITARM in your environment. export DEVKITARM=<path to>devkitARM")
endif

TOPDIR ?= $(CURDIR)
include $(DEVKITARM)/3ds_rules

#---------------------------------------------------------------------------------
TARGET      := dsh-link
BUILD       := build
SOURCES     := source vendor/quirc vendor/cJSON
INCLUDES    := source vendor/quirc vendor/cJSON vendor/font8x8
APP_TITLE   := DSH Link
APP_DESCRIPTION := Drive DeepSeek Harness sessions from a 3DS
APP_AUTHOR  := Mikey O'Brien
ICON        := icon.png

#---------------------------------------------------------------------------------
ARCH        := -march=armv6k -mtune=mpcore -mfloat-abi=hard -mtp=soft

CFLAGS      := -g -Wall -Wextra -Wno-format-truncation -Wno-sign-compare -O2 -mword-relocations -ffunction-sections -fdata-sections -std=gnu11 \
               $(ARCH) $(INCLUDE) -D__3DS__

ASFLAGS     := -g $(ARCH)
LDFLAGS     = -specs=3dsx.specs -g $(ARCH) -Wl,-Map,$(notdir $*.map)

LIBS        := -lctru -lm

LIBDIRS     := $(CTRULIB)

#---------------------------------------------------------------------------------
ifneq ($(BUILD),$(notdir $(CURDIR)))
#---------------------------------------------------------------------------------

export OUTPUT       := $(CURDIR)/$(TARGET)
export TOPDIR       := $(CURDIR)

export VPATH        := $(foreach dir,$(SOURCES),$(CURDIR)/$(dir))
export DEPSDIR      := $(CURDIR)/$(BUILD)

CFILES              := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.c)))
CPPFILES            := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.cpp)))
SFILES              := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.s)))

export OFILES       := $(CPPFILES:.cpp=.o) $(CFILES:.c=.o) $(SFILES:.s=.o)

export INCLUDE      := $(foreach dir,$(INCLUDES),-I$(CURDIR)/$(dir)) \
                       $(foreach dir,$(LIBDIRS),-I$(dir)/include) \
                       -I$(CURDIR)/$(BUILD)
export LIBPATHS     := $(foreach dir,$(LIBDIRS),-L$(dir)/lib)

export LD           := $(CC)
export APP_ICON     := $(TOPDIR)/$(ICON)
export _3DSXFLAGS   += --smdh=$(CURDIR)/$(TARGET).smdh

.PHONY: all clean

all: $(BUILD)
	@$(MAKE) --no-print-directory -C $(BUILD) -f $(CURDIR)/Makefile

$(BUILD):
	@mkdir -p $@

clean:
	@rm -fr $(BUILD) $(TARGET).3dsx $(OUTPUT).smdh $(TARGET).elf

#---------------------------------------------------------------------------------
else

$(OUTPUT).3dsx   : $(OUTPUT).elf $(OUTPUT).smdh
$(OUTPUT).elf    : $(OFILES)

%.o : %.c
	$(CC) $(CFLAGS) -MMD -MP -MF $(DEPSDIR)/$*.d -c $< -o $@

%.o : %.s
	$(CC) $(ASFLAGS) -c $< -o $@

-include $(DEPSDIR)/*.d

#---------------------------------------------------------------------------------------
endif
#---------------------------------------------------------------------------------------
